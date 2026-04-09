import { describe, expectTypeOf, it } from 'vitest';

import type {
  Agent,
  AgentLite,
  AvailableGroup,
  RegisteredGroup,
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
});
