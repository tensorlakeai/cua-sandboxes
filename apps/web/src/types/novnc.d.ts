declare module "@novnc/novnc/lib/rfb" {
  interface RfbCredentials {
    password?: string;
  }

  interface RfbOptions {
    shared?: boolean;
    credentials?: RfbCredentials;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);

    background: string;
    clipViewport: boolean;
    compressionLevel: number;
    qualityLevel: number;
    scaleViewport: boolean;
    showDotCursor: boolean;
    viewOnly: boolean;

    disconnect(): void;
    focus(): void;
  }
}
