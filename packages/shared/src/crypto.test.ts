import { describe, expect, it } from 'vitest';
import { hashPassword, randomToken, sha256Hex, timingSafeEqual, verifyPassword } from './crypto';
import { toWompiCents } from './money';

describe('contraseñas PBKDF2', () => {
  it('verifica la contraseña correcta y rechaza la incorrecta', async () => {
    const hash = await hashPassword('una-clave-larga-123', 1000);
    expect(hash.startsWith('pbkdf2-sha256$1000$')).toBe(true);
    expect(await verifyPassword('una-clave-larga-123', hash)).toBe(true);
    expect(await verifyPassword('otra-clave', hash)).toBe(false);
  });

  it('usa sal distinta en cada hash', async () => {
    const a = await hashPassword('misma', 1000);
    const b = await hashPassword('misma', 1000);
    expect(a).not.toBe(b);
  });

  it('rechaza formatos de hash inválidos', async () => {
    expect(await verifyPassword('x', 'basura')).toBe(false);
    expect(await verifyPassword('x', 'md5$1$a$b')).toBe(false);
  });
});

describe('utilidades', () => {
  it('genera tokens únicos y hash determinista', async () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('timingSafeEqual compara contenido y longitud', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });

  it('convierte COP a centavos de Wompi', () => {
    expect(toWompiCents(45000)).toBe(4_500_000);
    expect(() => toWompiCents(10.5)).toThrow();
  });
});
