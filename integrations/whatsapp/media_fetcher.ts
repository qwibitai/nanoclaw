export async function fetchWhatsAppMedia(
  mediaId: string,
  accessToken: string
): Promise<Buffer> {
  // Step 1: Resolve the media_id to a download URL
  const urlResponse = await fetch(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!urlResponse.ok) {
    throw new Error(`Failed to resolve media URL: ${urlResponse.statusText}`);
  }

  const { url } = await urlResponse.json();

  // Step 2: Download the binary
  const mediaResponse = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!mediaResponse.ok) {
    throw new Error(`Failed to download media: ${mediaResponse.statusText}`);
  }

  const arrayBuffer = await mediaResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
