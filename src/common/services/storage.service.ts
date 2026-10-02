import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

export interface StorageUploadResult {
  url: string;
  key: string;
  publicId?: string;
  provider: 'cloudinary' | 's3' | 'local';
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client | null = null;
  private bucketName: string;
  private localDir: string;
  private isCloudinaryConfigured = false;
  private useLocalFallback = false;

  constructor(private readonly config: ConfigService) {
    this.bucketName =
      this.config.get<string>('S3_BUCKET') || 'brainros-reports';
    const s3Endpoint = this.config.get<string>('S3_ENDPOINT');
    const accessKey = this.config.get<string>('S3_ACCESS_KEY');
    const secretKey = this.config.get<string>('S3_SECRET_KEY');
    const region = this.config.get<string>('S3_REGION') || 'us-east-1';

    // ── 1. Initialize Cloudinary ──
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');
    const cloudinaryUrl = this.config.get<string>('CLOUDINARY_URL');

    if (cloudinaryUrl) {
      cloudinary.config({
        cloudinary_url: cloudinaryUrl,
        secure: true,
      });
      this.isCloudinaryConfigured = true;
      this.logger.log('Cloudinary storage initialized via CLOUDINARY_URL');
    } else if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      this.isCloudinaryConfigured = true;
      this.logger.log(`Cloudinary storage initialized for cloud: ${cloudName}`);
    }

    // ── 2. Initialize S3 ──
    this.localDir = path.resolve(process.cwd(), 'storage', 'uploads');

    if (accessKey && secretKey) {
      try {
        this.s3Client = new S3Client({
          region,
          endpoint: s3Endpoint || undefined,
          credentials: {
            accessKeyId: accessKey,
            accessKeySecret: secretKey,
          } as any,
          forcePathStyle: true,
        });
      } catch (err: any) {
        this.logger.warn(
          `Failed to initialize S3 client: ${err.message}. Using local storage fallback.`,
        );
        this.useLocalFallback = true;
      }
    } else {
      this.useLocalFallback = true;
    }

    if (!fs.existsSync(this.localDir)) {
      fs.mkdirSync(this.localDir, { recursive: true });
    }
  }

  /**
   * Upload an image buffer with first-class Cloudinary support, automatic CDN optimization,
   * with seamless fallback to S3 or local storage.
   */
  async uploadImage(
    buffer: Buffer,
    originalName: string,
    mimetype: string,
    folder = 'brainros/question-images',
  ): Promise<StorageUploadResult> {
    // 1. Prioritize Cloudinary if configured
    if (this.isCloudinaryConfigured) {
      try {
        const result = await new Promise<UploadApiResponse>((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder,
              resource_type: 'auto',
              use_filename: true,
              unique_filename: true,
              overwrite: false,
            },
            (error, result) => {
              if (error || !result) {
                return reject(error || new Error('Cloudinary upload returned empty response'));
              }
              resolve(result);
            },
          );

          const stream = new Readable();
          stream.push(buffer);
          stream.push(null);
          stream.pipe(uploadStream);
        });

        this.logger.log(`Image uploaded to Cloudinary successfully: ${result.secure_url}`);
        return {
          url: result.secure_url,
          key: result.public_id,
          publicId: result.public_id,
          provider: 'cloudinary',
        };
      } catch (cloudErr: any) {
        this.logger.error(`Cloudinary upload failed: ${cloudErr.message}. Falling back...`);
      }
    }

    // 2. S3 upload
    const sanitizedName = (originalName || 'image.png').replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${folder}/${Date.now()}-${sanitizedName}`;

    if (!this.useLocalFallback && this.s3Client) {
      try {
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: key,
            Body: buffer,
            ContentType: mimetype,
          }),
        );
        const url = await this.getDownloadUrl(key, 86400 * 30);
        return { url, key, provider: 's3' };
      } catch (err: any) {
        this.logger.warn(`S3 image upload failed: ${err.message}. Falling back to local storage.`);
      }
    }

    // 3. Local filesystem storage fallback
    const localFilename = `${Date.now()}-${sanitizedName}`;
    const fullPath = path.join(this.localDir, localFilename);
    await fs.promises.writeFile(fullPath, buffer);

    return {
      url: `/storage/uploads/${localFilename}`,
      key: localFilename,
      provider: 'local',
    };
  }

  /**
   * Upload a file buffer to storage.
   * Returns storage key or public URL.
   */
  async uploadFile(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    if (this.isCloudinaryConfigured && contentType.startsWith('image/')) {
      const res = await this.uploadImage(buffer, path.basename(key), contentType);
      return res.url;
    }

    if (!this.useLocalFallback && this.s3Client) {
      try {
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucketName,
            Key: key,
            Body: buffer,
            ContentType: contentType,
          }),
        );
        return key;
      } catch (err: any) {
        this.logger.warn(
          `S3 upload failed: ${err.message}. Falling back to local storage.`,
        );
        this.useLocalFallback = true;
      }
    }

    // Local filesystem storage fallback
    const fullPath = path.join(this.localDir, path.basename(key));
    await fs.promises.writeFile(fullPath, buffer);
    return key;
  }

  /**
   * Generate a signed or temporary download URL (valid for 1 hour by default).
   */
  async getDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    if (key.startsWith('http://') || key.startsWith('https://')) {
      return key;
    }

    if (!this.useLocalFallback && this.s3Client) {
      try {
        const command = new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        });
        return await getSignedUrl(this.s3Client, command, {
          expiresIn: expiresInSeconds,
        });
      } catch (err: any) {
        this.logger.warn(
          `Failed to generate S3 presigned URL for ${key}: ${err.message}`,
        );
      }
    }

    // Return relative or data fallback
    return `/storage/uploads/${path.basename(key)}`;
  }
}
