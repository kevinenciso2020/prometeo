import { describe, expect, it } from 'vitest';
import { isCloudinaryUrl, isManagedPublicId, parseCloudinaryUrl } from './cloudinary';
import { slugify } from './schemas/catalog';

describe('cloudinary', () => {
  it('valida el dominio y el cloud name', () => {
    expect(isCloudinaryUrl('https://res.cloudinary.com/demo/image/upload/v1/a.jpg', 'demo')).toBe(
      true,
    );
    expect(isCloudinaryUrl('https://res.cloudinary.com/otro/image/upload/a.jpg', 'demo')).toBe(
      false,
    );
    expect(isCloudinaryUrl('http://res.cloudinary.com/demo/image/upload/a.jpg', 'demo')).toBe(
      false,
    );
    expect(
      isCloudinaryUrl('https://res.cloudinary.com.evil.io/demo/image/upload/a.jpg', 'demo'),
    ).toBe(false);
    expect(isCloudinaryUrl('https://u:p@res.cloudinary.com/demo/image/upload/a.jpg', 'demo')).toBe(
      false,
    );
  });

  it('extrae el public_id ignorando versión y transformaciones', () => {
    const base = 'https://res.cloudinary.com/demo/image/upload';
    expect(parseCloudinaryUrl(`${base}/v1699/prometeo/products/taza.jpg`, 'demo')?.publicId).toBe(
      'prometeo/products/taza',
    );
    expect(
      parseCloudinaryUrl(`${base}/f_auto,q_auto,w_400/v1/prometeo/products/taza.png`, 'demo')
        ?.publicId,
    ).toBe('prometeo/products/taza');
    expect(parseCloudinaryUrl(`${base}/sample.jpg`, 'demo')?.publicId).toBe('sample');
    expect(parseCloudinaryUrl('https://example.com/a.jpg', 'demo')).toBeNull();
  });

  it('solo gestiona recursos de la carpeta prometeo/', () => {
    expect(isManagedPublicId('prometeo/products/a')).toBe(true);
    expect(isManagedPublicId('sample')).toBe(false);
    expect(isManagedPublicId('prometeo/../x')).toBe(false);
  });

  it('genera slugs sin tildes', () => {
    expect(slugify('Jarrón Año Nuevo!')).toBe('jarron-ano-nuevo');
  });
});
