#!/usr/bin/env bun
/**
 * QuarterPlan MCP Server
 * Provides tools for managing initiatives, tracking PRs, and ARR data
 * Uses shared S3 utilities for backend storage
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SharedS3Client, QuarterPlanSync, type Initiative } from '../../shared/index.js';

// Validate required environment variables
const requiredEnvVars = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    console.error(`Error: Required environment variable ${varName} is not set`);
    process.exit(1);
  }
}

// Initialize S3 client from environment
const s3 = new SharedS3Client({
  endpoint: process.env.S3_ENDPOINT || 's3.us-east-005.backblazeb2.com',
  bucket: process.env.S3_BUCKET || 'omniaura-agents',
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION,
});

const quarterplan = new QuarterPlanSync(s3);

const server = new Server({ name: 'quarterplan', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_initiative',
      description: 'Create a new initiative in the quarter plan',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          owner: { type: 'string' },
          target_date: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'description', 'owner'],
      },
    },
    {
      name: 'update_initiative',
      description: 'Update an existing initiative',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['planning', 'in-progress', 'completed', 'blocked'] },
          description: { type: 'string' },
          target_date: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
    },
    {
      name: 'link_pr',
      description: 'Link a GitHub PR to an initiative',
      inputSchema: {
        type: 'object',
        properties: { initiative_id: { type: 'string' }, pr_url: { type: 'string' } },
        required: ['initiative_id', 'pr_url'],
      },
    },
    {
      name: 'get_quarter_plan',
      description: 'Get the current quarter plan',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['planning', 'in-progress', 'completed', 'blocked'] } },
      },
    },
    {
      name: 'add_update',
      description: 'Add a progress update to an initiative',
      inputSchema: {
        type: 'object',
        properties: { initiative_id: { type: 'string' }, update: { type: 'string' }, author: { type: 'string' } },
        required: ['initiative_id', 'update', 'author'],
      },
    },
    {
      name: 'update_arr_data',
      description: 'Update ARR/MRR statistics',
      inputSchema: {
        type: 'object',
        properties: { mrr: { type: 'number' }, arr: { type: 'number' }, users: { type: 'number' } },
      },
    },
    {
      name: 'get_arr_data',
      description: 'Get current ARR/MRR statistics',
      inputSchema: { type: 'object' },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'create_initiative': {
        const plan = await quarterplan.getQuarterPlan();
        const initiative: Initiative = {
          id: `init-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          title: args.title,
          description: args.description,
          owner: args.owner,
          status: 'planning',
          prs: [],
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          target_date: args.target_date,
          tags: args.tags,
        };
        plan.initiatives.push(initiative);
        await quarterplan.saveQuarterPlan(plan);
        return { content: [{ type: 'text', text: JSON.stringify(initiative, null, 2) }] };
      }
      case 'update_initiative': {
        const plan = await quarterplan.getQuarterPlan();
        const initiative = plan.initiatives.find((i) => i.id === args.id);
        if (!initiative) return { content: [{ type: 'text', text: `Initiative ${args.id} not found` }], isError: true };
        if (args.status) initiative.status = args.status as any;
        if (args.description) initiative.description = args.description as string;
        if (args.target_date) initiative.target_date = args.target_date as string;
        if (args.tags) initiative.tags = args.tags as string[];
        initiative.updated = new Date().toISOString();
        await quarterplan.saveQuarterPlan(plan);
        return { content: [{ type: 'text', text: JSON.stringify(initiative, null, 2) }] };
      }
      case 'link_pr': {
        const plan = await quarterplan.getQuarterPlan();
        const initiative = plan.initiatives.find((i) => i.id === args.initiative_id);
        if (!initiative) return { content: [{ type: 'text', text: `Initiative ${args.initiative_id} not found` }], isError: true };
        if (!initiative.prs.includes(args.pr_url as string)) {
          initiative.prs.push(args.pr_url as string);
          initiative.updated = new Date().toISOString();
          await quarterplan.saveQuarterPlan(plan);
        }
        return { content: [{ type: 'text', text: `PR linked to ${initiative.title}` }] };
      }
      case 'get_quarter_plan': {
        const plan = await quarterplan.getQuarterPlan();
        let initiatives = plan.initiatives;
        if (args.status) initiatives = initiatives.filter((i) => i.status === args.status);
        return { content: [{ type: 'text', text: JSON.stringify({ ...plan, initiatives }, null, 2) }] };
      }
      case 'add_update': {
        await quarterplan.addUpdate(args.initiative_id as string, args.update as string, args.author as string);
        return { content: [{ type: 'text', text: `Update added to ${args.initiative_id}` }] };
      }
      case 'update_arr_data': {
        const current = await quarterplan.getARRData();
        const updated = { mrr: (args.mrr as number) ?? current.mrr, arr: (args.arr as number) ?? current.arr, users: (args.users as number) ?? current.users, updated: new Date().toISOString() };
        await quarterplan.saveARRData(updated);
        return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
      }
      case 'get_arr_data': {
        const data = await quarterplan.getARRData();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    console.error('Tool execution error:', error);
    return { content: [{ type: 'text', text: `Error executing tool: ${name}` }], isError: true };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch(console.error);
