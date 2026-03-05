# Verifier
**Add a new agent role Verifier.**
This new role will be in addition to the Planner (Orchestrator) and the Worker roles.

## Responsibility
It is the verifier's roles to read the work of the worker agent.

The verifier should:
    1. Ensure the worker's output satisfies the assigned task's acceptance criteria
    2. Ensure the worker's output is qualitatively up-to-par with the philosophy described in the Homie's CLAUDE.md

If the above are not deemed satisfactory to the verifier it should create a revisions file within the "/Users/vinchenkov/Documents/dev/claws/NanoClaw/groups/homie/mission-control/revisions" folder. The file name should follow the template I-<taskname>-REVISION.md.

The verifier should then **respawn a worker agent** assigning the same task, pointing to the same deliverable that was previously produced (whether it is in the outputs/ folder or whether it was some git branch/worktree), and the newly created REVISION file.

**The verifier is now in charge of releasing the lock.json** as only it can 

## Full Flow
The new total agent flow should be as follows:
   1. Planner plans initiatives/tasks
   2. Spawns a worker agent with assigned work
   3. Worker executes work
   4. Worker creates deliverables in outputs/ folder or provides the git worktree/branch details
   5. Worker adds task updates, detailing how to access the deliverables
   6. Worker spawns verifier with brief message on its assigned task/deliverables
   7. Verifier scrutinizes work and creates a revision file, IF NECESSARY.
   8. Verifier spawns new worker to address feedback.
   9. Steps 3 through 8 repeat a maximum of 3 times.
   10. After verifier is satisfied with work, or the maximum loop count is reached, the verifier