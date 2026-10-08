export function sitePath(path = "", base = import.meta.env.BASE_URL): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
