/**
 * Railway GraphQL API wrapper for NanoClaw.
 * Provides lifecycle management for Railway services.
 */

import { RAILWAY_API_TOKEN } from '../config.js';
import { logger } from '../logger.js';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!RAILWAY_API_TOKEN) {
    throw new Error('RAILWAY_API_TOKEN not set');
  }

  const resp = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RAILWAY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    throw new Error(`Railway API error: ${resp.status} ${await resp.text()}`);
  }

  const result = await resp.json() as GraphQLResponse<T>;
  if (result.errors?.length) {
    throw new Error(`Railway GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`);
  }
  if (!result.data) {
    throw new Error('Railway GraphQL returned no data');
  }
  return result.data;
}

export interface RailwayProject {
  id: string;
  name: string;
}

export interface RailwayService {
  id: string;
  name: string;
}

export interface RailwayDeployment {
  id: string;
  status: string;
}

/** Create a new Railway project. */
export async function createProject(name: string): Promise<RailwayProject> {
  const data = await graphql<{ projectCreate: RailwayProject }>(`
    mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name }
    }
  `, { input: { name } });
  logger.info({ projectId: data.projectCreate.id, name }, 'Created Railway project');
  return data.projectCreate;
}

/** Create a service within a project. */
export async function createService(projectId: string, name: string): Promise<RailwayService> {
  const data = await graphql<{ serviceCreate: RailwayService }>(`
    mutation($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }
  `, { input: { projectId, name } });
  logger.info({ serviceId: data.serviceCreate.id, name }, 'Created Railway service');
  return data.serviceCreate;
}

/** Set environment variables on a service. */
export async function setServiceVariables(
  projectId: string,
  serviceId: string,
  environmentId: string,
  variables: Record<string, string>,
): Promise<void> {
  await graphql(`
    mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `, {
    input: {
      projectId,
      serviceId,
      environmentId,
      variables,
    },
  });
  logger.debug({ serviceId, varCount: Object.keys(variables).length }, 'Set Railway service variables');
}

/** Deploy a service from a Docker image. */
export async function deployService(
  projectId: string,
  serviceId: string,
  environmentId: string,
  image: string,
): Promise<RailwayDeployment> {
  const data = await graphql<{ serviceInstanceDeploy: RailwayDeployment }>(`
    mutation($input: ServiceInstanceDeployInput!) {
      serviceInstanceDeploy(input: $input) { id status }
    }
  `, {
    input: {
      serviceId,
      environmentId,
      source: { image },
    },
  });
  logger.info({ deploymentId: data.serviceInstanceDeploy.id, image }, 'Deployed Railway service');
  return data.serviceInstanceDeploy;
}

/** Delete a service. */
export async function deleteService(serviceId: string): Promise<void> {
  await graphql(`
    mutation($id: String!) {
      serviceDelete(id: $id)
    }
  `, { id: serviceId });
  logger.info({ serviceId }, 'Deleted Railway service');
}

/** Get project environments. */
export async function getProjectEnvironments(projectId: string): Promise<Array<{ id: string; name: string }>> {
  const data = await graphql<{ environments: { edges: Array<{ node: { id: string; name: string } }> } }>(`
    query($projectId: String!) {
      environments(projectId: $projectId) {
        edges { node { id name } }
      }
    }
  `, { projectId });
  return data.environments.edges.map((e) => e.node);
}

/** Get deployment status. */
export async function getDeploymentStatus(deploymentId: string): Promise<string> {
  const data = await graphql<{ deployment: { status: string } }>(`
    query($id: String!) {
      deployment(id: $id) { status }
    }
  `, { id: deploymentId });
  return data.deployment.status;
}
