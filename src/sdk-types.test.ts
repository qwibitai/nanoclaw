import { describe, expectTypeOf, it } from 'vitest';

import type { Agent, AvailableGroup, RegisteredGroup } from './api/sdk.js';

describe('public SDK type exports', () => {
  it('exposes group getters with public group types', () => {
    type RegisteredGroupsList = ReturnType<Agent['getRegisteredGroups']>;
    type AvailableGroupsList = ReturnType<Agent['getAvailableGroups']>;

    expectTypeOf<RegisteredGroupsList>().toEqualTypeOf<RegisteredGroup[]>();
    expectTypeOf<AvailableGroupsList>().toEqualTypeOf<AvailableGroup[]>();
  });
});
