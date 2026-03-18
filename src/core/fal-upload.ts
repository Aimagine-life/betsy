import path from "node:path";

/** Upload a buffer to fal.ai storage and return its public URL. */
export async function uploadToFal(
  buffer: Buffer,
  filename: string,
  falApiKey: string,
): Promise<string> {
  const ext = path.extname(filename).slice(1) || "bin";
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };
  const contentType = mimeTypes[ext] || "application/octet-stream";

  const res = await fetch("https://fal.run/fal-ai/any/upload", {
    method: "PUT",
    headers: {
      Authorization: `Key ${falApiKey}`,
      "Content-Type": contentType,
    },
    body: new Uint8Array(buffer),
  });

  if (!res.ok) {
    const base64 = buffer.toString("base64");
    return `data:${contentType};base64,${base64}`;
  }

  const data = (await res.json()) as { url?: string };
  if (data.url) return data.url;

  const base64 = buffer.toString("base64");
  return `data:${contentType};base64,${base64}`;
}
