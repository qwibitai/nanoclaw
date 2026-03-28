import { fetchWhatsAppMedia } from "./media_fetcher";

const mockMediaUrl = "https://cdn.whatsapp.net/media/abc123";
const mockBinary = Buffer.from("fake-image-data");

global.fetch = jest.fn()
  .mockResolvedValueOnce({
    ok: true,
    json: async () => ({ url: mockMediaUrl }),
  } as any)
  .mockResolvedValueOnce({
    ok: true,
    arrayBuffer: async () => mockBinary.buffer,
  } as any);

describe("fetchWhatsAppMedia", () => {
  it("fetches media and returns a Buffer", async () => {
    const result = await fetchWhatsAppMedia("media-id-123", "test-token");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws if the URL lookup fails", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: false, statusText: "Unauthorized" });
    await expect(fetchWhatsAppMedia("bad-id", "bad-token")).rejects.toThrow("Failed to resolve media URL");
  });
});
