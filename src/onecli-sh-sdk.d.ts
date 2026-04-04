// Type stub for optional peer dependency @onecli-sh/sdk.
// The actual module is loaded dynamically and may not be installed.
declare module '@onecli-sh/sdk' {
  export class OneCLI {
    constructor(opts: { url: string });
    getCredentials(opts: {
      service: string;
      scopes?: string[];
    }): Promise<Record<string, string>>;
  }
}
