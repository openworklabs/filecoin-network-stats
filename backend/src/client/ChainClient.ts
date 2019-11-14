import HTTPClient, {CurriedCall} from './HTTPClient';
import {RawBlockJSON} from '../domain/BlockJSON';
import {BlockFromClientWithMessages} from '../domain/BlockFromClient';
import {MessageJSON} from '../domain/MessageJSON';
import {Message} from '../domain/Message';
import BigNumber from 'bignumber.js';
import {methodDecoders} from './ABI';
import makeLogger from '../util/logger';


const logger = makeLogger('ChainClient');

interface HeadJSON {
  '/': string
}

export interface IChainClient {
  ls (toBlock: number): Promise<BlockFromClientWithMessages[]>
}

export class ChainClientImpl implements IChainClient {
  private client: HTTPClient;
  private readonly callAPI: CurriedCall['callAPI'];

  constructor (client: HTTPClient) {
    this.client = client;
    this.callAPI = client.forService('show/block').callAPI;
  }

  async ls (toBlock: number): Promise<BlockFromClientWithMessages[]> {
    const headsRaw = await this.client.getJSON<HeadJSON[]>('chain/head');
    const heads = headsRaw.map((h) => h['/']);
    const unconfBlocks: BlockFromClientWithMessages[] = [];
    logger.info('fetching heads', {
      heads
    });

    const insertedParents: {[k:string]: boolean} = {};
    const heights: number[] = [];
    let count = 0
    while (count < 5) {
      const head = heads.shift();
      const block = await this.fetchBlock(head);
      if (block.height > toBlock) {
        for (const parent of block.parents) {
          if (!insertedParents[parent]) {
            insertedParents[parent] = true;
            heads.push(parent);
            count++
          }
        }

        unconfBlocks.push(block);
        if (heights[0] != block.height) {
          heights.unshift(block.height);
        }
      }
    }

    const prunedHeights = heights.slice(0, -2);
    const maxHeight = prunedHeights[prunedHeights.length - 1];
    logger.info('pruned heads', {
      retrievedHeight: heights[heights.length - 1],
      maxHeight,
      toBlock,
    });
    return unconfBlocks.filter((block: BlockFromClientWithMessages) => block.height <= maxHeight);
  }

  private inflateMessages (messages: MessageJSON[] | null, height: number, tipsetHash: string): Message[] {
    if (!messages) {
      return [];
    }

    return messages.map((wrapper: MessageJSON, i: number) => {
      const m = wrapper.meteredMessage;
      return {
        height,
        tipsetHash,
        index: i,
        gasPrice: new BigNumber(m.gasPrice),
        gasLimit: new BigNumber(m.gasLimit),
        from: m.message.from,
        to: m.message.to,
        value: m.message.value ? new BigNumber(m.message.value) : null,
        method: m.message.method,
        params: this.decodeParams(m.message.method, m.message.params),
        nonce: Number(m.message.nonce),
      };
    });
  }

  private decodeParams (name: string, data: string): any {
    if (!data) {
      return null;
    }

    const decoder = methodDecoders[name];
    if (!decoder) {
      return data;
    }

    return decoder(data);
  }

  private async fetchBlock (tipsetHash: string): Promise<BlockFromClientWithMessages> {
    const json = await this.client.getJSON<RawBlockJSON>(`show/block/${tipsetHash}`);
    const height = Number(json.Header.height);
    const parents = json.Header.parents ? json.Header.parents.map((p) => p['/']) : [];

    return {
      height,
      tipsetHash,
      parents,
      miner: json.Header.miner,
      parentWeight: Number(json.Header.parentWeight),
      messages: this.inflateMessages(json.Messages, height, tipsetHash),
    };
  }
}
