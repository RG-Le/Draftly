import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../shared/logger.js';

/**
 * CeleryBridge — dispatches tasks to the Python AI Engine's Celery workers.
 *
 * Protocol: Celery uses Redis as a message broker. A task is a JSON message
 * pushed to the queue key `celery` (or a named queue like `triage-queue`).
 *
 * Message format follows Celery's v2 protocol:
 * https://docs.celeryq.dev/en/stable/internals/protocol.html
 */
export class CeleryBridge {
  constructor(private readonly redis: Redis) {}

  /**
   * Dispatch a triage classification task to the Python AI Engine.
   */
  async dispatchTriageTask(params: {
    threadId: string;
    userId: string;
    correlationId: string;
  }): Promise<string> {
    const taskId = uuidv4();

    const message = this.buildCeleryMessage({
      taskId,
      taskName: 'ai.triage.classify',
      queue: 'triage-queue',
      args: [params.threadId, params.correlationId, params.userId],
      kwargs: {},
    });

    await this.publishToQueue('triage-queue', message);

    logger.info(
      { taskId, threadId: params.threadId, queue: 'triage-queue' },
      'CeleryBridge: triage task dispatched',
    );

    return taskId;
  }

  /**
   * Dispatch a draft generation task to the Python AI Engine.
   */
  async dispatchDraftTask(params: {
    threadId: string;
    userId: string;
    correlationId: string;
  }): Promise<string> {
    const taskId = uuidv4();

    const message = this.buildCeleryMessage({
      taskId,
      taskName: 'ai.draft.generate',
      queue: 'draft-queue',
      args: [params.threadId, params.correlationId, params.userId],
      kwargs: {},
    });

    await this.publishToQueue('draft-queue', message);

    logger.info(
      { taskId, threadId: params.threadId, queue: 'draft-queue' },
      'CeleryBridge: draft task dispatched',
    );

    return taskId;
  }

  /**
   * Dispatch a profile update task to the Python AI Engine.
   */
  async dispatchProfileUpdateTask(params: {
    userId: string;
    draftId: string;
    correlationId: string;
  }): Promise<string> {
    const taskId = uuidv4();

    const message = this.buildCeleryMessage({
      taskId,
      taskName: 'ai.profile.update',
      queue: 'profile-queue',
      args: [params.userId, params.draftId, params.correlationId],
      kwargs: {},
    });

    await this.publishToQueue('profile-queue', message);

    logger.info(
      { taskId, userId: params.userId, queue: 'profile-queue' },
      'CeleryBridge: profile update task dispatched',
    );

    return taskId;
  }

  /**
   * Dispatch a batch triage task — classifies multiple threads in a single LLM call.
   */
  async dispatchTriageBatchTask(params: {
    threadIds: string[];
    userId: string;
    correlationId: string;
  }): Promise<string> {
    const taskId = uuidv4();

    const message = this.buildCeleryMessage({
      taskId,
      taskName: 'ai.triage.classify_batch',
      queue: 'triage-queue',
      args: [params.threadIds, params.correlationId, params.userId],
      kwargs: {},
    });

    await this.publishToQueue('triage-queue', message);

    logger.info(
      { taskId, threadCount: params.threadIds.length, queue: 'triage-queue' },
      'CeleryBridge: batch triage task dispatched',
    );

    return taskId;
  }

  /**
   * Dispatch a profile build task (initial persona bootstrap from sent emails).
   */
  async dispatchProfileBuildTask(params: {
    userId: string;
    correlationId: string;
  }): Promise<string> {
    const taskId = uuidv4();

    const message = this.buildCeleryMessage({
      taskId,
      taskName: 'ai.profile.build',
      queue: 'profile-queue',
      args: [params.userId],
      kwargs: {},
    });

    await this.publishToQueue('profile-queue', message);

    logger.info(
      { taskId, userId: params.userId, queue: 'profile-queue' },
      'CeleryBridge: profile build task dispatched',
    );

    return taskId;
  }

  // ===== Internal =====

  private buildCeleryMessage(params: {
    taskId: string;
    taskName: string;
    queue: string;
    args: unknown[];
    kwargs: Record<string, unknown>;
  }): string {
    // Celery v2 protocol message
    const body = {
      id: params.taskId,
      task: params.taskName,
      args: params.args,
      kwargs: params.kwargs,
      retries: 0,
      eta: null,
      expires: null,
    };

    // The full message envelope
    const envelope = {
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
      'content-encoding': 'utf-8',
      'content-type': 'application/json',
      headers: {
        lang: 'py',
        task: params.taskName,
        id: params.taskId,
        root_id: params.taskId,
        parent_id: null,
        group: null,
        argsrepr: JSON.stringify(params.args),
        kwargsrepr: JSON.stringify(params.kwargs),
        origin: 'draftly-gateway',
      },
      properties: {
        correlation_id: params.taskId,
        content_type: 'application/json',
        content_encoding: 'utf-8',
        body_encoding: 'base64',
        delivery_info: {
          exchange: '',
          routing_key: params.queue,
        },
        delivery_mode: 2, // persistent
        delivery_tag: uuidv4(),
        priority: 0,
      },
    };

    return JSON.stringify(envelope);
  }

  private async publishToQueue(queue: string, message: string): Promise<void> {
    // Celery with Redis broker uses LPUSH to the queue key
    const queueLength = await this.redis.lpush(queue, message);
    logger.debug({ queue, queueDepth: queueLength }, 'CeleryBridge: message pushed to Redis queue');
  }
}
