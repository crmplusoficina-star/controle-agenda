export function useEmbeddedImage(dataUri: string) {
  return dataUri;
}

export function useEmbeddedImages(dataUris: readonly string[]) {
  return [...dataUris];
}
