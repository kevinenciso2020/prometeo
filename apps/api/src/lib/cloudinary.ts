import {
  ALLOWED_IMAGE_FORMATS,
  MAX_IMAGE_BYTES,
  isManagedPublicId,
  type UploadFolder,
} from '@prometeo/shared';

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface SignedUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: UploadFolder;
  allowedFormats: string;
  signature: string;
  uploadUrl: string;
  maxFileSize: number;
}

export interface CloudinaryClient {
  signUpload(folder: UploadFolder): Promise<SignedUpload>;
  /** Borra la imagen en Cloudinary. Ignora recursos fuera de la carpeta prometeo/. */
  destroy(publicId: string): Promise<boolean>;
}

/** Firma de Cloudinary: params ordenados alfabéticamente (k=v&...) + api_secret, SHA-1 en hex. */
export async function signParams(
  params: Record<string, string | number>,
  apiSecret: string,
): Promise<string> {
  const toSign =
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&') + apiSecret;
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(toSign));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createCloudinary(
  cfg: CloudinaryConfig,
  fetchImpl: typeof fetch = fetch,
): CloudinaryClient {
  return {
    async signUpload(folder) {
      const timestamp = Math.floor(Date.now() / 1000);
      const allowedFormats = ALLOWED_IMAGE_FORMATS.join(',');
      const signature = await signParams(
        { allowed_formats: allowedFormats, folder, timestamp },
        cfg.apiSecret,
      );
      return {
        cloudName: cfg.cloudName,
        apiKey: cfg.apiKey,
        timestamp,
        folder,
        allowedFormats,
        signature,
        uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`,
        maxFileSize: MAX_IMAGE_BYTES,
      };
    },

    async destroy(publicId) {
      if (!isManagedPublicId(publicId)) return false;
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await signParams(
        { invalidate: 'true', public_id: publicId, timestamp },
        cfg.apiSecret,
      );
      const body = new URLSearchParams({
        public_id: publicId,
        timestamp: String(timestamp),
        invalidate: 'true',
        api_key: cfg.apiKey,
        signature,
      });
      const res = await fetchImpl(
        `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/destroy`,
        {
          method: 'POST',
          body,
        },
      );
      if (!res.ok) {
        console.error(`[cloudinary] destroy respondió ${res.status}`);
        return false;
      }
      return true;
    },
  };
}
