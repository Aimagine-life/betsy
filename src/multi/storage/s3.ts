import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export function buildWorkspaceKey(workspaceId: string, suffix: string): string {
  const clean = suffix.replace(/^\/+/, '')
  return `workspaces/${workspaceId}/${clean}`
}

export function buildPersonaKey(workspaceId: string, filename: string): string {
  return buildWorkspaceKey(workspaceId, `persona/${filename}`)
}

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export class S3Storage {
  private client: S3Client
  private bucket: string

  constructor(cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: true,
    })
    this.bucket = cfg.bucket
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )
    return key
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
    const stream = response.Body as any
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
  }

  async signedUrl(key: string, ttlSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    )
  }
}

let instance: S3Storage | null = null

export function buildS3Storage(cfg: S3Config): S3Storage {
  if (!instance) instance = new S3Storage(cfg)
  return instance
}

export function getS3Storage(): S3Storage {
  if (!instance) throw new Error('S3 storage not initialized — call buildS3Storage first')
  return instance
}
