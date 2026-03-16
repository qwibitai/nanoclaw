import amqplib from 'amqplib';

import {
  CRON_EXCHANGE,
  CronExchange,
  type CronJobTriggered,
} from '@jeffrey-keyser/message-contracts';

import { RABBITMQ_URL } from './config.js';
import { getTaskById } from './db.js';
import { logger } from './logger.js';
import { SchedulerDependencies, runScheduledTask } from './task-scheduler.js';

const QUEUE_NAME = 'nanoclaw.cron';
const ROUTING_KEY = 'nanoclaw.#';
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;

let conn: amqplib.ChannelModel | null = null;
let ch: amqplib.Channel | null = null;
let stopping = false;

/**
 * Start subscribing to CronJobTriggered events from the cron-service.
 * Replaces the internal SQLite polling loop. The cron-service manages
 * schedules and publishes trigger events to the cron.jobs exchange.
 *
 * Tasks are matched by jobId → task.id in the scheduled_tasks table.
 * The payload may also carry a taskId field for explicit mapping.
 */
export async function startCronSubscriber(
  deps: SchedulerDependencies,
): Promise<void> {
  stopping = false;
  await connectAndSubscribe(deps, RECONNECT_DELAY_MS);
}

/**
 * Gracefully close the RabbitMQ connection.
 */
export async function stopCronSubscriber(): Promise<void> {
  stopping = true;
  try {
    if (ch) {
      await ch.close();
      ch = null;
    }
    if (conn) {
      await conn.close();
      conn = null;
    }
    logger.info('Cron subscriber stopped');
  } catch (err) {
    logger.warn({ err }, 'Error closing cron subscriber connection');
  }
}

async function connectAndSubscribe(
  deps: SchedulerDependencies,
  delay: number,
): Promise<void> {
  if (stopping) return;

  try {
    const newConn = await amqplib.connect(RABBITMQ_URL);
    conn = newConn;
    logger.info('Connected to RabbitMQ for cron subscription');

    newConn.on('error', (err: Error) => {
      logger.error({ err }, 'RabbitMQ connection error');
    });

    newConn.on('close', () => {
      if (stopping) return;
      logger.warn('RabbitMQ connection closed, reconnecting...');
      conn = null;
      ch = null;
      scheduleReconnect(deps, delay);
    });

    const newCh = await newConn.createChannel();
    ch = newCh;

    // Assert the exchange (idempotent — matches cron-service declaration)
    await newCh.assertExchange(CRON_EXCHANGE, CronExchange.type, {
      durable: CronExchange.durable,
    });

    // Declare a durable queue for NanoClaw so messages survive restarts
    await newCh.assertQueue(QUEUE_NAME, { durable: true });

    // Bind to nanoclaw-prefixed routing keys on the topic exchange
    await newCh.bindQueue(QUEUE_NAME, CRON_EXCHANGE, ROUTING_KEY);

    await newCh.consume(
      QUEUE_NAME,
      (msg) => {
        if (!msg) return;
        handleCronEvent(msg, newCh, deps);
      },
      { noAck: false },
    );

    logger.info(
      { exchange: CRON_EXCHANGE, queue: QUEUE_NAME, routingKey: ROUTING_KEY },
      'Cron subscriber listening',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to connect to RabbitMQ');
    conn = null;
    ch = null;
    scheduleReconnect(deps, delay);
  }
}

function scheduleReconnect(
  deps: SchedulerDependencies,
  delay: number,
): void {
  if (stopping) return;
  const nextDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
  logger.info({ delayMs: delay }, 'Scheduling RabbitMQ reconnect');
  setTimeout(() => connectAndSubscribe(deps, nextDelay), delay);
}

function handleCronEvent(
  msg: amqplib.ConsumeMessage,
  ackChannel: amqplib.Channel,
  deps: SchedulerDependencies,
): void {
  let event: CronJobTriggered;
  try {
    event = JSON.parse(msg.content.toString()) as CronJobTriggered;
  } catch (err) {
    logger.error({ err }, 'Failed to parse CronJobTriggered message');
    ackChannel.ack(msg);
    return;
  }

  const routingKey = msg.fields.routingKey;
  const log = logger.child({
    op: 'cron-event',
    jobId: event.jobId,
    jobName: event.jobName,
    runId: event.runId,
    routingKey,
  });

  // Resolve the task ID — prefer explicit payload.taskId, fall back to jobId
  const taskId =
    typeof event.payload?.taskId === 'string'
      ? event.payload.taskId
      : event.jobId;

  const task = getTaskById(taskId);
  if (!task) {
    log.debug('No matching task found for cron event, ignoring');
    ackChannel.ack(msg);
    return;
  }

  if (task.status !== 'active') {
    log.info({ taskId, status: task.status }, 'Task not active, skipping');
    ackChannel.ack(msg);
    return;
  }

  log.info({ taskId }, 'Cron event received, enqueuing task');

  // Enqueue the task for execution (same path as the old polling loop)
  deps.queue.enqueueTask(task.chat_jid, task.id, () =>
    runScheduledTask(task, deps),
  );

  ackChannel.ack(msg);
}
