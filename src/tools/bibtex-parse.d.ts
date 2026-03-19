declare module 'bibtex-parse' {
  interface BibEntry {
    key: string;
    type: string;
    [field: string]: string | undefined;
  }
  function entries(bibtex: string): BibEntry[];
  export default { entries };
}
