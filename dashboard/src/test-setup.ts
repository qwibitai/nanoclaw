import '@testing-library/jest-dom';

// jsdom doesn't implement matchMedia; provide a no-op stub so components
// that call it on mount don't crash in tests. Tests that care about mobile
// behavior override this with vi.stubGlobal in their own beforeEach.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
