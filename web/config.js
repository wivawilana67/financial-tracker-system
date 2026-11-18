// Which copy of the app this is. The deploy publishes develop under /test/ and master at the root.
const base = new URL('./', import.meta.url).pathname;
export const ENV = base.endsWith('/test/') ? 'test' : 'prod';
export const IS_TEST = ENV === 'test';
export const STORAGE_PREFIX = IS_TEST ? 'fintrack.test.' : 'fintrack.';
