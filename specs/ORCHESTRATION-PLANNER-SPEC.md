# ORCHESTRATION-WORKER REVISION
**You are a planner** that will write a comprehensive, ordered, implementation specification for a worker agent to implement.

## The Orchestrator-Worker framework
Read the CLAUDE.md file at the base of the NanoClaw directory to understand the framework as it is.
Also make sure to read "/Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/CLAUDE.md" and "/Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/workers/WORKERS.md" to understand what I expect out of the framework.

## What I still want
The core of the framework is a **2-layer heiarchy system that contains a planner and worker subagents** that are spawned to execute tasks (workers).

There should still be a canoncial state "Initiatives" and "Tasks" that make up all the planned/seeded work thus far.
Also part of the canonical state should be the /outputs delivered by previous agents AND the actual workspaces ("dirtsignals" repo etc.).
This is already sort of communicated in the CLAUDE/WORKERS.mds.

## Unique roles/context
This NanoClaw configuration needs to ensure that only the planner gets the CLAUDE.md context that details the planner's responsibility. Maybe rename this to ORCHESTRATOR or PLANNER.md?
Worker agents spawned by the PLANNER should only have the WORKERS.md and the initiative/task they were assigned.

## Antiquated
Based on the nature of the NanoClaw harness, that uses the Claude SDK, I believe the lock.json file in the original framework is not needed.
The subagent spawned by the planner should just communicate to the planner whenever it finishes. Once it does, it the planner should start orchestrating/planning the next work that should be executed.
You **should confirm** if this is possible:
o- nanoclaw process boots -> 15-min heartbeat -> planner boots and starts planning -> spawns a worker agent to execute work -> planner WAITS | worker works -> worker finishes/notifies planner -> planner restarts planning.

So actually I need you to research which is the better/available option. After Planner spawns worker agent, does planner wait 15,30,60 minutes for worker to finish? If so does it not burn tokens by doing so and is actually IDLE?
OR should the planner self-terminate once a worker subagent is spawned? In this case, it seems like the lock.json is needed because there wouldn't be any cross-communication between the two. Now that I think about it, can a worker agent even survive if its parent self-termiates?

These are open questions.