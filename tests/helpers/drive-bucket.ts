// A bounded in-memory R2 test double. Production-bundle tests also exercise
// multipart staging against the real workerd R2 binding.
export class DriveBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, { bytes: Uint8Array; etag: string }> }>();
  partWrites = 0;
  binding() { return this as unknown as R2Bucket; }
  async list(options?: { prefix?: string; limit?: number }) { return { objects: [...this.objects].filter(([key]) => key.startsWith(options?.prefix ?? "")).map(([key, value]) => ({ key, size: value.bytes.length, etag: value.etag })).sort((a, b) => a.key.localeCompare(b.key)).slice(0, options?.limit ?? 1000) }; }
  async delete(keys: string | string[]) { for (const key of typeof keys === "string" ? [keys] : keys) this.objects.delete(key); }
  async head(key: string) { const value = this.objects.get(key); return value ? { key, size: value.bytes.length, etag: value.etag } : null; }
  async get(key: string, options?: { onlyIf?: { etagMatches?: string } }) {
    const value = this.objects.get(key);
    if (!value || options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== value.etag) return null;
    return { ...await this.head(key), body: new Response(value.bytes.slice().buffer).body! };
  }
  async createMultipartUpload(key: string) {
    const id = crypto.randomUUID(); this.uploads.set(id, { key, parts: new Map() }); return this.resumeMultipartUpload(key, id);
  }
  resumeMultipartUpload(key: string, id: string) {
    return {
      key, uploadId: id,
      uploadPart: async (partNumber: number, bytes: Uint8Array) => {
        const upload = this.uploads.get(id); if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
        const etag = crypto.randomUUID(); upload.parts.set(partNumber, { bytes: bytes.slice(), etag }); this.partWrites++;
        return { partNumber, etag };
      },
      abort: async () => { this.uploads.delete(id); },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const upload = this.uploads.get(id); if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
        const selected = parts.map(part => { const value = upload.parts.get(part.partNumber); if (!value || value.etag !== part.etag) throw new Error("InvalidPart"); return value.bytes; });
        const bytes = new Uint8Array(selected.reduce((size, part) => size + part.length, 0)); let offset = 0;
        for (const part of selected) { bytes.set(part, offset); offset += part.length; }
        this.objects.set(key, { bytes, etag: crypto.randomUUID() }); this.uploads.delete(id); return (await this.head(key))!;
      },
    };
  }
}
