import { Action, Poke, Scry, Thread } from '@urbit/api';

export interface PokeHandlers {
  onSuccess?: () => void;
  onError?: (e: any) => void;
}

export type PokeInterface<T> = PokeHandlers & Poke<T>;

export interface AuthenticationInterface {
  ship: string;
  url: string;
  code: string;
  verbose?: boolean;
}

export interface SubscriptionInterface {
  err?(error: any): void;
  event?(data: any): void;
  quit?(data: any): void;
}

export type SubscriptionRequestInterface = SubscriptionInterface & {
  app: string;
  path: string;
}

export interface headers {
  'Content-Type': string;
  Cookie?: string;
}

export interface UrbitInterface {
  uid: string;
  lastEventId: number;
  lastAcknowledgedEventId: number;
  sseClientInitialized: boolean;
  cookie?: string | undefined;
  outstandingPokes: Map<number, PokeHandlers>;
  outstandingSubscriptions: Map<number, SubscriptionInterface>;
  verbose?: boolean;
  ship?: string | null;
  connect(): void;
  connect(): Promise<void>;
  eventSource(): void;
  getEventId(): number;
  ack(eventId: number): Promise<void | number>;
  sendMessage(action: Action, data?: object): Promise<void | number>;
  poke<T>(params: PokeInterface<T>): Promise<void | number>;
  subscribe(params: SubscriptionRequestInterface): Promise<void | number>;
  unsubscribe(subscription: string): Promise<void | number>;
  delete(): Promise<void | number>;
  scry(params: Scry): Promise<void | any>;
  thread<T>(params: Thread<T>): Promise<T>;
}

export interface CustomEventHandler {
  (data: any, response: string): void;
}

export interface SSEOptions {
  headers?: {
    Cookie?: string
  };
  withCredentials?: boolean;
}
