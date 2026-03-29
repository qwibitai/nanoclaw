#!/usr/bin/env node
/**
 * X Bot Task Poller
 * Polls MongoDB for tasks assigned to X (Service Bot) and executes them
 */

const { MongoClient, ObjectId } = require('mongodb');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://relay:hJnU0YgaH8QnZhfx@cluster0.fo939jr.mongodb.net/relay?appName=Cluster0';
const BOT_NAME = 'x';
const POLL_INTERVAL = 10000; // 10 seconds

class XBotPoller {
  constructor() {
    this.client = null;
    this.db = null;
    this.tasks = null;
    this.running = false;
    this.currentTask = null;
  }

  async connect() {
    this.client = new MongoClient(MONGODB_URI);
    await this.client.connect();
    this.db = this.client.db('relay');
    this.tasks = this.db.collection('tasks');
    console.log(`[${new Date().toISOString()}] X Bot connected to MongoDB`);
  }

  async poll() {
    try {
      // Check for dependencies first
      const task = await this.tasks.findOne({
        bot: BOT_NAME,
        status: 'assigned'
      });

      if (!task) {
        // Check for "any" bot tasks
        const anyTask = await this.tasks.findOne({
          bot: 'any',
          status: 'assigned'
        });
        return anyTask;
      }

      return task;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Polling error:`, error.message);
      return null;
    }
  }

  async checkDependencies(task) {
    if (!task.depends_on || task.depends_on.length === 0) {
      return true;
    }

    for (const depId of task.depends_on) {
      const depTask = await this.tasks.findOne({ _id: new ObjectId(depId) });
      if (!depTask || depTask.status !== 'completed') {
        console.log(`[${new Date().toISOString()}] Task ${task._id} waiting for dependency ${depId}`);
        return false;
      }
    }

    return true;
  }

  async claim(task) {
    try {
      const result = await this.tasks.updateOne(
        { _id: task._id, status: 'assigned' }, // Only claim if still assigned
        {
          $set: {
            status: 'in_progress',
            claimed_by: BOT_NAME,
            claimed_at: new Date(),
            updated_at: new Date()
          }
        }
      );

      return result.modifiedCount > 0;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Claim error:`, error.message);
      return false;
    }
  }

  async heartbeat(taskId) {
    try {
      await this.tasks.updateOne(
        { _id: taskId },
        {
          $set: {
            last_heartbeat: new Date(),
            updated_at: new Date()
          }
        }
      );
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Heartbeat error:`, error.message);
    }
  }

  async execute(task) {
    console.log(`\n[${new Date().toISOString()}] ==============================`);
    console.log(`[${new Date().toISOString()}] Executing task: ${task.title}`);
    console.log(`[${new Date().toISOString()}] Description: ${task.description}`);
    console.log(`[${new Date().toISOString()}] Priority: ${task.priority}`);
    console.log(`[${new Date().toISOString()}] ==============================\n`);

    try {
      // Start heartbeat for long-running tasks
      const heartbeatInterval = setInterval(() => {
        this.heartbeat(task._id);
      }, 60000); // Every minute

      // Execute the task based on description
      // For now, this is a simple implementation
      // In production, X would have more sophisticated task handling

      let outcome = '';
      let lessons = '';

      // Check if task is cancelled mid-execution
      const checkCancellation = async () => {
        const currentTask = await this.tasks.findOne({ _id: task._id });
        if (currentTask.status === 'cancelled') {
          clearInterval(heartbeatInterval);
          console.log(`[${new Date().toISOString()}] Task cancelled mid-execution`);
          return true;
        }
        return false;
      };

      // Simple task execution simulation
      // In real implementation, X would parse the task and execute appropriate actions
      await new Promise(resolve => setTimeout(resolve, 5000)); // Simulate work

      if (await checkCancellation()) {
        return;
      }

      outcome = `Task "${task.title}" completed by X Bot`;
      lessons = 'Task polling and execution workflow validated';

      // Complete the task
      clearInterval(heartbeatInterval);

      await this.tasks.updateOne(
        { _id: task._id },
        {
          $set: {
            status: 'completed',
            outcome: outcome,
            lessons: lessons,
            completed_at: new Date(),
            updated_at: new Date()
          }
        }
      );

      console.log(`[${new Date().toISOString()}] Task completed successfully`);
      console.log(`[${new Date().toISOString()}] Outcome: ${outcome}\n`);

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Execution error:`, error.message);

      await this.tasks.updateOne(
        { _id: task._id },
        {
          $set: {
            status: 'failed',
            failure_reason: error.message,
            updated_at: new Date()
          },
          $inc: {
            retry_count: 1
          }
        }
      );
    }
  }

  async start() {
    this.running = true;
    console.log(`[${new Date().toISOString()}] X Bot poller started`);
    console.log(`[${new Date().toISOString()}] Poll interval: ${POLL_INTERVAL}ms`);
    console.log(`[${new Date().toISOString()}] Monitoring tasks for: ${BOT_NAME}\n`);

    while (this.running) {
      try {
        // Check for task
        const task = await this.poll();

        if (task) {
          // Check dependencies
          const canStart = await this.checkDependencies(task);

          if (!canStart) {
            // Wait and check again
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
            continue;
          }

          // Try to claim
          const claimed = await this.claim(task);

          if (claimed) {
            this.currentTask = task;
            await this.execute(task);
            this.currentTask = null;
          } else {
            console.log(`[${new Date().toISOString()}] Task ${task._id} already claimed by another bot`);
          }
        } else {
          // No tasks, wait
          process.stdout.write(`\r[${new Date().toISOString()}] No tasks available, polling...`);
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

      } catch (error) {
        console.error(`[${new Date().toISOString()}] Loop error:`, error.message);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }
    }
  }

  async stop() {
    this.running = false;
    if (this.client) {
      await this.client.close();
    }
    console.log(`\n[${new Date().toISOString()}] X Bot poller stopped`);
  }
}

// Start poller
const poller = new XBotPoller();

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.log('\n\nReceived SIGINT, shutting down gracefully...');
  await poller.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\nReceived SIGTERM, shutting down gracefully...');
  await poller.stop();
  process.exit(0);
});

// Start
poller.connect()
  .then(() => poller.start())
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
