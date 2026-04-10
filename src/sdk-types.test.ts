import { describe, expectTypeOf, it } from 'vitest';

import type {
  Agent,
  AgentLite,
  AvailableGroup,
  RegisteredGroup,
  Task,
  TaskDetails,
} from './api/sdk.js';

describe('public SDK type exports', () => {
  it('exposes group getters with public group types', () => {
    type RegisteredGroupsList = ReturnType<Agent['getRegisteredGroups']>;
    type AvailableGroupsList = ReturnType<Agent['getAvailableGroups']>;

    expectTypeOf<RegisteredGroupsList>().toEqualTypeOf<RegisteredGroup[]>();
    expectTypeOf<AvailableGroupsList>().toEqualTypeOf<AvailableGroup[]>();
  });

  it('exposes getOrCreateAgent with the same agent return type', () => {
    type GetOrCreateAgent = ReturnType<AgentLite['getOrCreateAgent']>;

    expectTypeOf<GetOrCreateAgent>().toEqualTypeOf<Agent>();
  });

  it('exposes task APIs with public task types', () => {
    type ScheduleTaskResult = Awaited<ReturnType<Agent['scheduleTask']>>;
    type ListTasksResult = ReturnType<Agent['listTasks']>;
    type GetTaskResult = ReturnType<Agent['getTask']>;
    type UpdateTaskResult = Awaited<ReturnType<Agent['updateTask']>>;
    type PauseTaskResult = Awaited<ReturnType<Agent['pauseTask']>>;
    type ResumeTaskResult = Awaited<ReturnType<Agent['resumeTask']>>;

    expectTypeOf<ScheduleTaskResult>().toEqualTypeOf<Task>();
    expectTypeOf<ListTasksResult>().toEqualTypeOf<Task[]>();
    expectTypeOf<GetTaskResult>().toEqualTypeOf<TaskDetails | undefined>();
    expectTypeOf<UpdateTaskResult>().toEqualTypeOf<Task>();
    expectTypeOf<PauseTaskResult>().toEqualTypeOf<Task>();
    expectTypeOf<ResumeTaskResult>().toEqualTypeOf<Task>();
  });
});
