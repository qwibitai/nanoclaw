import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { IncomingMessage, ServerResponse } from 'http';
import { logger } from './logger.js';

export async function handleBedrockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  region: string,
  modelId: string,
) {
  try {
    const client = new BedrockRuntimeClient({
      region,
      credentials: fromNodeProviderChain(),
    });

    const anthropicRequest = JSON.parse(body.toString('utf-8'));

    // Anthropic API passes the model name in the payload, but we override it
    // with the one specified in the environment for Bedrock.
    // Bedrock optionally uses `anthropic.claude-v2` or `anthropic.claude-3-haiku-20240307-v1:0` formats.
    const bedrockPayload = {
      ...anthropicRequest,
      anthropic_version: anthropicRequest.anthropic_version || 'bedrock-2023-05-31',
    };
    
    // Remove the model key as Bedrock specifies it in the URI, not the payload
    delete bedrockPayload.model;

    const stream = anthropicRequest.stream === true;

    if (stream) {
      const command = new InvokeModelWithResponseStreamCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(bedrockPayload),
      });

      const response = await client.send(command);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      if (response.body) {
        for await (const chunk of response.body) {
          if (chunk.chunk?.bytes) {
            // The chunk.bytes contains the SSE payload exactly as Anthropic sends it
            // (e.g. `event: message_start\ndata: {...}\n\n`)
            const decoded = Buffer.from(chunk.chunk.bytes).toString('utf-8');
            res.write(decoded);
          } else if (chunk.internalServerException) {
            logger.error({ err: chunk.internalServerException }, 'Bedrock stream exception');
          } else if (chunk.modelStreamErrorException) {
            logger.error({ err: chunk.modelStreamErrorException }, 'Bedrock model stream error');
          } else if (chunk.throttlingException) {
            logger.error({ err: chunk.throttlingException }, 'Bedrock throttling exception');
          } else if (chunk.validationException) {
            logger.error({ err: chunk.validationException }, 'Bedrock validation exception');
          }
        }
      }
      res.end();
    } else {
      const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(bedrockPayload),
      });

      const response = await client.send(command);
      
      res.writeHead(200, {
        'Content-Type': 'application/json',
      });
      
      const responseBody = Buffer.from(response.body).toString('utf-8');
      res.end(responseBody);
    }
  } catch (error) {
    logger.error({ error, url: req.url }, 'Bedrock proxy error');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          type: 'api_error',
          message: error instanceof Error ? error.message : 'Unknown Bedrock Error',
        }
      }));
    }
  }
}
