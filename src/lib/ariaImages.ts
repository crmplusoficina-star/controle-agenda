import { useEffect, useMemo, useState } from 'react';

function dataUriToBlobUrl(dataUri: string) {
  if (!dataUri.startsWith('data:image/')) return dataUri;
  const match = dataUri.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return dataUri;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: match[1] }));
  } catch {
    return dataUri;
  }
}

export function useEmbeddedImage(dataUri: string) {
  const [src, setSrc] = useState(dataUri);

  useEffect(() => {
    const next = dataUriToBlobUrl(dataUri);
    setSrc(next);
    return () => {
      if (next.startsWith('blob:')) URL.revokeObjectURL(next);
    };
  }, [dataUri]);

  return src;
}

export function useEmbeddedImages(dataUris: readonly string[]) {
  const stable = useMemo(() => [...dataUris], [dataUris]);
  const [sources, setSources] = useState<string[]>(stable);

  useEffect(() => {
    const next = stable.map(dataUriToBlobUrl);
    setSources(next);
    return () => {
      next.forEach((src) => {
        if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      });
    };
  }, [stable]);

  return sources;
}
