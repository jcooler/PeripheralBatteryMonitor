export interface InspectorTransport<TMessage> {
  activeContextId(): string | undefined;
  send(message: TMessage): Promise<void>;
}

/** Routes replies only to the Property Inspector that initiated a request. */
export class InspectorMessenger<TMessage = unknown> {
  constructor(private readonly transport: InspectorTransport<TMessage>) {}

  async send(contextId: string, message: TMessage): Promise<boolean> {
    if (this.transport.activeContextId() !== contextId) return false;
    try {
      await this.transport.send(message);
      return true;
    } catch {
      return false;
    }
  }
}
