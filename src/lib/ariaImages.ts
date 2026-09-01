const publicAriaImages = [
  '/aria/aria-1.png?v=20260901-2',
  '/aria/aria-2.png?v=20260901-2',
  '/aria/aria-3.png?v=20260901-2',
  '/aria/aria-4.png?v=20260901-2',
] as const;

export function useEmbeddedImage(_dataUri: string) {
  return publicAriaImages[0];
}

export function useEmbeddedImages(dataUris: readonly string[]) {
  if (!dataUris.length) return [];
  return dataUris.map((_, index) => publicAriaImages[index % publicAriaImages.length]);
}
