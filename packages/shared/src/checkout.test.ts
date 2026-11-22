import { describe, expect, it } from 'vitest';
import { sha256Hex } from './crypto';
import { DEPARTMENTS, MUNICIPALITIES, getMunicipalities, isValidLocation } from './divipola';
import {
  ORDER_STATUSES,
  adminOrderTransitions,
  canAdminChangeOrder,
  canMarkOrderPaid,
  isOrderPayable,
} from './orders';
import { checkoutOrderSchema, updateOrderStatusSchema } from './schemas/checkout';
import {
  computeEventChecksum,
  parseWompiTransaction,
  verifyEventChecksum,
  wompiIntegritySignature,
  type WompiEvent,
} from './wompi';

describe('firma de integridad de Wompi', () => {
  it('es SHA256(referencia + centavos + COP + secreto)', async () => {
    const sig = await wompiIntegritySignature({
      reference: 'ORD-1-abc',
      amountInCents: 4_500_000,
      secret: 'test_integrity_x',
    });
    expect(sig).toBe(await sha256Hex('ORD-1-abc4500000COPtest_integrity_x'));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('coincide con el ejemplo de la documentación de Wompi', async () => {
    // https://docs.wompi.co/docs/colombia/ — ejemplo oficial: referencia sk8-438k4-xmxm392-sn2m, 2490000 centavos, secreto prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6
    const sig = await wompiIntegritySignature({
      reference: 'sk8-438k4-xmxm392-sn2m',
      amountInCents: 2_490_000,
      secret: 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6',
    });
    expect(sig).toBe('37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5');
  });

  it('incluye la expiración antes del secreto y rechaza montos inválidos', async () => {
    const sig = await wompiIntegritySignature({
      reference: 'r',
      amountInCents: 100,
      expirationTime: '2030-01-01T00:00:00.000Z',
      secret: 's',
    });
    expect(sig).toBe(await sha256Hex('r100COP2030-01-01T00:00:00.000Zs'));
    expect(() =>
      wompiIntegritySignature({ reference: 'r', amountInCents: 10.5, secret: 's' }),
    ).toThrow();
    expect(() =>
      wompiIntegritySignature({ reference: 'r', amountInCents: 0, secret: 's' }),
    ).toThrow();
  });
});

describe('checksum de eventos de Wompi', () => {
  const SECRET = 'test_events_secret';
  const base = (): WompiEvent => ({
    event: 'transaction.updated',
    data: {
      transaction: {
        id: '1234-1610641025-49201',
        status: 'APPROVED',
        amount_in_cents: 4_490_000,
        reference: 'ORD-1-abc',
        currency: 'COP',
      },
    },
    environment: 'test',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: '',
    },
    timestamp: 1_530_291_411,
  });
  const signed = async (mut?: (e: WompiEvent) => void) => {
    const e = base();
    e.signature.checksum = (
      await sha256Hex(`1234-1610641025-49201APPROVED44900001530291411${SECRET}`)
    ).toUpperCase();
    mut?.(e);
    return e;
  };

  it('concatena propiedades + timestamp + secreto', async () => {
    const e = await signed();
    expect(await computeEventChecksum(e, SECRET)).toBe(e.signature.checksum.toLowerCase());
  });

  it('sigue el procedimiento documentado por Wompi (cadena verificada con sha256sum)', async () => {
    // La cadena y el secreto son los del ejemplo oficial. El checksum del ejemplo en la documentación es
    // ilustrativo (no coincide con su propia cadena), por eso el valor esperado se calculó con `sha256sum`.
    const e = base();
    e.signature.checksum = '5a18ec5e8fdb7df463e9f94774cba8f583ba21bd04a09ceff2ea68a4bc0aefbe';
    expect(await verifyEventChecksum(e, 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z')).toBe(true);
  });

  it('acepta un evento válido (mayúsculas o minúsculas)', async () => {
    expect(await verifyEventChecksum(await signed(), SECRET)).toBe(true);
    expect(
      await verifyEventChecksum(
        await signed((e) => (e.signature.checksum = e.signature.checksum.toLowerCase())),
        SECRET,
      ),
    ).toBe(true);
  });

  it('rechaza secreto incorrecto, datos alterados y checksum inválido', async () => {
    expect(await verifyEventChecksum(await signed(), 'otro_secreto')).toBe(false);
    for (const mut of [
      (e: WompiEvent) => ((e.data.transaction as Record<string, unknown>).status = 'DECLINED'),
      (e: WompiEvent) => ((e.data.transaction as Record<string, unknown>).amount_in_cents = 100),
      (e: WompiEvent) => ((e.data.transaction as Record<string, unknown>).id = 'otro'),
      (e: WompiEvent) => (e.timestamp = 1),
      (e: WompiEvent) => (e.signature.checksum = 'zz'),
      (e: WompiEvent) => (e.signature.checksum = ''),
    ]) {
      expect(await verifyEventChecksum(await signed(mut), SECRET)).toBe(false);
    }
  });

  it('exige que id, estado y monto estén firmados (no acepta firmas parciales)', async () => {
    const e = base();
    e.signature.properties = ['transaction.id'];
    e.signature.checksum = await sha256Hex(`1234-1610641025-492011530291411${SECRET}`);
    expect(await verifyEventChecksum(e, SECRET)).toBe(false);
    e.signature.properties = ['transaction.id', 'transaction.status', 'transaction.inexistente'];
    expect(await verifyEventChecksum(e, SECRET)).toBe(false);
  });

  it('extrae la transacción y rechaza estados desconocidos', async () => {
    expect(parseWompiTransaction(await signed())).toEqual({
      id: '1234-1610641025-49201',
      status: 'APPROVED',
      amountInCents: 4_490_000,
      reference: 'ORD-1-abc',
      currency: 'COP',
    });
    expect(
      parseWompiTransaction(
        await signed((e) => ((e.data.transaction as Record<string, unknown>).status = 'HACKED')),
      ),
    ).toBeNull();
    expect(parseWompiTransaction({ ...base(), data: {} })).toBeNull();
  });
});

describe('DIVIPOLA', () => {
  it('trae 33 departamentos y 1.122 municipios', () => {
    expect(DEPARTMENTS).toHaveLength(33);
    expect(Object.values(MUNICIPALITIES).reduce((n, m) => n + m.length, 0)).toBe(1122);
  });
  it('valida que el municipio pertenezca al departamento', () => {
    expect(isValidLocation('05', '05001')).toBe(true); // Medellín en Antioquia
    expect(isValidLocation('11', '11001')).toBe(true); // Bogotá
    expect(isValidLocation('76', '05001')).toBe(false);
    expect(isValidLocation('99', '99999')).toBe(false);
    expect(getMunicipalities('05').find((m) => m.code === '05001')?.name).toBe('Medellín');
  });
  it('todo municipio empieza con el código de su departamento', () => {
    for (const [dep, list] of Object.entries(MUNICIPALITIES))
      for (const [code] of list) expect(code.startsWith(dep)).toBe(true);
  });
});

describe('estados de pedido', () => {
  it('el admin avanza pagado → preparando → enviado → entregado', () => {
    expect(canAdminChangeOrder('pagado', 'preparando')).toBe(true);
    expect(canAdminChangeOrder('preparando', 'enviado')).toBe(true);
    expect(canAdminChangeOrder('enviado', 'entregado')).toBe(true);
  });
  it('el admin NO puede marcar como pagado (solo el webhook) ni retroceder', () => {
    expect(canAdminChangeOrder('pendiente_pago', 'pagado')).toBe(false);
    expect(canAdminChangeOrder('enviado', 'preparando')).toBe(false);
    expect(canAdminChangeOrder('entregado', 'cancelado')).toBe(false);
    expect(canAdminChangeOrder('cancelado', 'pagado')).toBe(false);
  });
  it('un pedido enviado no se cancela y los terminales no tienen salidas', () => {
    expect(canAdminChangeOrder('enviado', 'cancelado')).toBe(false);
    expect(adminOrderTransitions('entregado')).toEqual([]);
    expect(adminOrderTransitions('cancelado')).toEqual([]);
    expect(ORDER_STATUSES).toHaveLength(6);
  });
  it('solo pendiente_pago puede confirmarse y pagarse', () => {
    expect(canMarkOrderPaid('pendiente_pago')).toBe(true);
    for (const s of ORDER_STATUSES.filter((x) => x !== 'pendiente_pago')) {
      expect(canMarkOrderPaid(s)).toBe(false);
      expect(isOrderPayable(s)).toBe(false);
    }
  });
});

describe('esquemas de checkout', () => {
  const base = {
    items: [{ type: 'product', id: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
    name: 'Ana Pérez',
    email: 'ANA@correo.com',
    phone: '3001234567',
    shipping: { departmentCode: '05', municipalityCode: '05001', address: 'Calle 10 # 20-30' },
    acceptDataPolicy: true,
    acceptTerms: true,
  };
  it('acepta un checkout válido y normaliza el correo', () => {
    const r = checkoutOrderSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('ana@correo.com');
  });
  it('rechaza municipio de otro departamento y falta de autorizaciones', () => {
    expect(
      checkoutOrderSchema.safeParse({
        ...base,
        shipping: { ...base.shipping, departmentCode: '76' },
      }).success,
    ).toBe(false);
    expect(checkoutOrderSchema.safeParse({ ...base, acceptDataPolicy: false }).success).toBe(false);
    expect(checkoutOrderSchema.safeParse({ ...base, acceptTerms: false }).success).toBe(false);
  });
  it('enviar un pedido exige número de guía', () => {
    expect(updateOrderStatusSchema.safeParse({ status: 'enviado' }).success).toBe(false);
    expect(
      updateOrderStatusSchema.safeParse({ status: 'enviado', trackingNumber: 'SER123' }).success,
    ).toBe(true);
    expect(updateOrderStatusSchema.safeParse({ status: 'preparando' }).success).toBe(true);
  });
});
