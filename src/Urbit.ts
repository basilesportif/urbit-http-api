import { isBrowser, isNode } from 'browser-or-node';
import { Action, Scry, Thread } from '@urbit/api';
import { fetchEventSource, EventSourceMessage } from '@microsoft/fetch-event-source';

import { AuthenticationInterface, SubscriptionInterface, CustomEventHandler, PokeInterface, SubscriptionRequestInterface, headers, UrbitInterface, SSEOptions, PokeHandlers } from './types';
import { uncamelize, hexString } from './utils';

/**
 * A class for interacting with an urbit ship, given its URL and code
 */
export class Urbit implements UrbitInterface {
  /**
   * UID will be used for the channel: The current unix time plus a random hex string
   */
  uid: string = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;

  /**
   * Last Event ID is an auto-updated index of which events have been sent over this channel
   */
  lastEventId: number = 0;

  lastAcknowledgedEventId: number = 0;

  /**
   * SSE Client is null for now; we don't want to start polling until it the channel exists
   */
  sseClientInitialized: boolean = false;

  /**
   * Cookie gets set when we log in.
   */
  cookie?: string | undefined;

  /**
   * A registry of requestId to successFunc/failureFunc
   * 
   * These functions are registered during a +poke and are executed
   * in the onServerEvent()/onServerError() callbacks. Only one of
   * the functions will be called, and the outstanding poke will be
   * removed after calling the success or failure function.
   */

  outstandingPokes: Map<number, PokeHandlers> = new Map();

  /**
   * A registry of requestId to subscription functions.
   * 
   * These functions are registered during a +subscribe and are
   * executed in the onServerEvent()/onServerError() callbacks. The
   * event function will be called whenever a new piece of data on this
   * subscription is available, which may be 0, 1, or many times. The
   * disconnect function may be called exactly once.
   */

  outstandingSubscriptions: Map<number, SubscriptionInterface> = new Map();

  /**
   * Ship can be set, in which case we can do some magic stuff like send chats
   */
  ship?: string | null;

  /**
   * If verbose, logs output eagerly.
   */
  verbose?: boolean;

  /** This is basic interpolation to get the channel URL of an instantiated Urbit connection. */
  get channelUrl(): string {
    return `${this.url}/~/channel/${this.uid}`;
  }

  get fetchOptions(): any {
    const headers: headers = {
      'Content-Type': 'application/json',
    };
    if (!isBrowser) {
      headers.Cookie = this.cookie;
    }
    return {
      credentials: 'include',
      headers
    };
  }

  /**
   * Constructs a new Urbit connection.
   *
   * @param url  The URL (with protocol and port) of the ship to be accessed
   * @param code The access code for the ship at that address
   */
  constructor(
    public url: string,
    public code: string
  ) {
    return this;
  }

  /**
   * All-in-one hook-me-up.
   * 
   * Given a ship, url, and code, this returns an airlock connection
   * that is ready to go. It `|hi`s itself to create the channel,
   * then opens the channel via EventSource.
   * 
   * @param AuthenticationInterface
   */
  static async authenticate({ ship, url, code, verbose = false }: AuthenticationInterface) {
    const airlock = new Urbit(`http://${url}`, code);
    airlock.verbose = verbose;
    airlock.ship = ship;
    await airlock.connect();
    await airlock.poke({ app: 'hood', mark: 'helm-hi', json: 'opening airlock' });
    await airlock.eventSource();
    return airlock;
  }

  /**
   * Connects to the Urbit ship. Nothing can be done until this is called.
   * That's why we roll it into this.authenticate
   */
  async connect(): Promise<void> {
    if (this.verbose) {
      console.log(`password=${this.code} `, isBrowser ? "Connecting in browser context at " + `${this.url}/~/login` : "Connecting from node context");
    }
    return fetch(`${this.url}/~/login`, {
      method: 'post',
      body: `password=${this.code}`,
      credentials: 'include',
    }).then(response => {
      if (this.verbose) {
        console.log('Received authentication response', response);
      }
      const cookie = response.headers.get('set-cookie');
      if (!this.ship) {
        this.ship = new RegExp(/urbauth-~([\w-]+)/).exec(cookie)[1];
      }
      if (!isBrowser) {
        this.cookie = cookie;
      }
    });
  }
  

  /**
   * Initializes the SSE pipe for the appropriate channel.
   */
  eventSource(): void{
    if (!this.sseClientInitialized) {
      const sseOptions: SSEOptions = {
        headers: {}
      };
      if (isBrowser) {
        sseOptions.withCredentials = true;
      } else if (isNode) {
        sseOptions.headers.Cookie = this.cookie;
      }
      fetchEventSource(this.channelUrl, {
        // withCredentials: true,
        onmessage: (event: EventSourceMessage) => {
          if (this.verbose) {
            console.log('Received SSE: ', event);
          }
          this.ack(Number(event.id));
          if (event.data && JSON.parse(event.data)) {
            const data: any = JSON.parse(event.data);
            if (data.response === 'poke' && this.outstandingPokes.has(data.id)) {
              const funcs = this.outstandingPokes.get(data.id);
              if (data.hasOwnProperty('ok')) {
                funcs.onSuccess();
              } else if (data.hasOwnProperty('err')) {
                funcs.onError(data.err);
              } else {
                console.error('Invalid poke response', data);
              }
              this.outstandingPokes.delete(data.id);
            } else if (data.response === 'subscribe' || 
              (data.response === 'poke' && this.outstandingSubscriptions.has(data.id))) {
              const funcs = this.outstandingSubscriptions.get(data.id);
              if (data.hasOwnProperty('err')) {
                funcs.err(data.err);
                this.outstandingSubscriptions.delete(data.id);
              }
            } else if (data.response === 'diff' && this.outstandingSubscriptions.has(data.id)) {
              const funcs = this.outstandingSubscriptions.get(data.id);
              funcs.event(data.json);
            } else if (data.response === 'quit' && this.outstandingSubscriptions.has(data.id)) {
              const funcs = this.outstandingSubscriptions.get(data.id);
              funcs.quit(data);
              this.outstandingSubscriptions.delete(data.id);
            } else {
              console.log('Unrecognized response', data);
            }
          }
        },
        onerror: (error) => {
          console.error('pipe error', error);
        }
      });
      this.sseClientInitialized = true;
    }
    return;
  }

  /**
   * Autoincrements the next event ID for the appropriate channel.
   */
  getEventId(): number {
    this.lastEventId = Number(this.lastEventId) + 1;
    return this.lastEventId;
  }

  /**
   * Acknowledges an event.
   *
   * @param eventId The event to acknowledge.
   */
   ack(eventId: number): Promise<void | number> {
    return this.sendMessage('ack', { 'event-id': eventId });
  }

  /**
   * This is a wrapper method that can be used to send any action with data.
   *
   * Every message sent has some common parameters, like method, headers, and data
   * structure, so this method exists to prevent duplication.
   *
   * @param action The action to send
   * @param data The data to send with the action
   * 
   * @returns void | number If successful, returns the number of the message that was sent
   */
  async sendMessage(action: Action, data?: object): Promise<void | number> {
    
    const id = this.getEventId();
    if (this.verbose) {
      console.log(`Sending message ${id}:`, action, data,);
    }
    let response: Response | undefined;
    try {
      response = await fetch(this.channelUrl, {
        ...this.fetchOptions,
        method: 'put',
        body: JSON.stringify([{
          id,
          action,
          ...data,
        }]),
      });
    } catch (error) {
      console.error('message error', error);
      response = undefined;
    }
    if (this.verbose) {
      console.log(`Received from message ${id}: `, response);
    }
    return id;
  }

  /**
   * Pokes a ship with data.
   *
   * @param app The app to poke
   * @param mark The mark of the data being sent
   * @param json The data to send
   */
  poke<T>(params: PokeInterface<T>): Promise<void | number> {
    const { app, mark, json, onSuccess, onError } = { onSuccess: () => {}, onError: () => {}, ...params };
    return new Promise((resolve, reject) => {
      this
        .sendMessage('poke', { ship: this.ship, app, mark, json })
        .then(pokeId => {
          if (!pokeId) {
            return reject('Poke failed');
          }
          if (!this.sseClientInitialized) resolve(pokeId); // A poke may occur before a listener has been opened
          this.outstandingPokes.set(pokeId, {
            onSuccess: () => {
              onSuccess();
              resolve(pokeId);
            },
            onError: (event) => {
              onError(event);
              reject(event.err);
            }
          });
        }).catch(error => {
          console.error(error);
        });
    });
  }

  /**
   * Subscribes to a path on an app on a ship.
   *
   * @param app The app to subsribe to
   * @param path The path to which to subscribe
   * @param handlers Handlers to deal with various events of the subscription
   */
  async subscribe(params: SubscriptionRequestInterface): Promise<void | number> {
    const { app, path, err, event, quit } = { err: () => {}, event: () => {}, quit: () => {}, ...params };

    const subscriptionId = await this.sendMessage('subscribe', { ship: this.ship, app, path });

    if (!subscriptionId) return;

    this.outstandingSubscriptions.set(subscriptionId, {
      err, event, quit
    });

    return subscriptionId;
  }

  /**
   * Unsubscribes to a given subscription.
   *
   * @param subscription
   */
  unsubscribe(subscription: string): Promise<void | number> {
    return this.sendMessage('unsubscribe', { subscription });
  }

  /**
   * Deletes the connection to a channel.
   */
  delete(): Promise<void | number> {
    return this.sendMessage('delete');
  }

  /**
   * 
   * @param app   The app into which to scry
   * @param path  The path at which to scry
   */
  async scry(params: Scry): Promise<void | any> {
    const { app, path } = params;
    const response = await fetch(`/~/scry/${app}${path}.json`, this.fetchOptions);
    return await response.json();
  }

  /**
   * 
   * @param inputMark   The mark of the data being sent
   * @param outputMark  The mark of the data being returned
   * @param threadName  The thread to run
   * @param body        The data to send to the thread
   */
  async thread<T>(params: Thread<T>): Promise<T> {
    const { inputMark, outputMark, threadName, body } = params;
    const res = await fetch(`/spider/${inputMark}/${threadName}/${outputMark}.json`, {
      ...this.fetchOptions,
      method: 'POST',
      body: JSON.stringify(body)
    });

    return res.json();
  }

  /**
   * Utility function to connect to a ship that has its *.arvo.network domain configured.
   *
   * @param name Name of the ship e.g. zod
   * @param code Code to log in
   */
  static async onArvoNetwork(ship: string, code: string): Promise<Urbit> {
    const url = `https://${ship}.arvo.network`;
    return await Urbit.authenticate({ ship, url, code });
  }
}



export default Urbit;
