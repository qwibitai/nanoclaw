import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from "./config.js";
import type { AvailableGroup } from "./container-runner.js";
import {
	createTask,
	deleteTask,
	getTaskById,
	getUserProfileByDiscordId,
	setUserProfile,
	updateTask,
} from "./db.js";
import { isValidGroupFolder } from "./group-folder.js";
import { logger } from "./logger.js";
import type { RegisteredGroup, UserProfile } from "./types.js";
import { lookupLinuxUser, validateUserSetup } from "./user-profile.js";

export interface IpcDeps {
	sendMessage: (jid: string, text: string) => Promise<void>;
	registeredGroups: () => Record<string, RegisteredGroup>;
	registerGroup: (jid: string, group: RegisteredGroup) => void;
	syncGroups: (force: boolean) => Promise<void>;
	getAvailableGroups: () => AvailableGroup[];
	writeGroupsSnapshot: (
		groupFolder: string,
		isMain: boolean,
		availableGroups: AvailableGroup[],
		registeredJids: Set<string>,
	) => void;
	onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
	if (ipcWatcherRunning) {
		logger.debug("IPC watcher already running, skipping duplicate start");
		return;
	}
	ipcWatcherRunning = true;

	const ipcBaseDir = path.join(DATA_DIR, "ipc");
	fs.mkdirSync(ipcBaseDir, { recursive: true });

	const processIpcFiles = async () => {
		// Scan all group IPC directories (identity determined by directory)
		let groupFolders: string[];
		try {
			groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
				const stat = fs.statSync(path.join(ipcBaseDir, f));
				return stat.isDirectory() && f !== "errors";
			});
		} catch (err) {
			logger.error({ err }, "Error reading IPC base directory");
			setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
			return;
		}

		const registeredGroups = deps.registeredGroups();

		// Build folder→isMain lookup from registered groups
		const folderIsMain = new Map<string, boolean>();
		for (const group of Object.values(registeredGroups)) {
			if (group.isMain) folderIsMain.set(group.folder, true);
		}

		for (const sourceGroup of groupFolders) {
			const isMain = folderIsMain.get(sourceGroup) === true;
			const messagesDir = path.join(ipcBaseDir, sourceGroup, "messages");
			const tasksDir = path.join(ipcBaseDir, sourceGroup, "tasks");

			// Process messages from this group's IPC directory
			try {
				if (fs.existsSync(messagesDir)) {
					const messageFiles = fs
						.readdirSync(messagesDir)
						.filter((f) => f.endsWith(".json"));
					for (const file of messageFiles) {
						const filePath = path.join(messagesDir, file);
						try {
							const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
							if (data.type === "message" && data.chatJid && data.text) {
								// Authorization: verify this group can send to this chatJid
								const targetGroup = registeredGroups[data.chatJid];
								if (
									isMain ||
									(targetGroup && targetGroup.folder === sourceGroup)
								) {
									await deps.sendMessage(data.chatJid, data.text);
									logger.info(
										{ chatJid: data.chatJid, sourceGroup },
										"IPC message sent",
									);
								} else {
									logger.warn(
										{ chatJid: data.chatJid, sourceGroup },
										"Unauthorized IPC message attempt blocked",
									);
								}
							}
							fs.unlinkSync(filePath);
						} catch (err) {
							logger.error(
								{ file, sourceGroup, err },
								"Error processing IPC message",
							);
							const errorDir = path.join(ipcBaseDir, "errors");
							fs.mkdirSync(errorDir, { recursive: true });
							fs.renameSync(
								filePath,
								path.join(errorDir, `${sourceGroup}-${file}`),
							);
						}
					}
				}
			} catch (err) {
				logger.error(
					{ err, sourceGroup },
					"Error reading IPC messages directory",
				);
			}

			// Process tasks from this group's IPC directory
			try {
				if (fs.existsSync(tasksDir)) {
					const taskFiles = fs
						.readdirSync(tasksDir)
						.filter((f) => f.endsWith(".json"));
					for (const file of taskFiles) {
						const filePath = path.join(tasksDir, file);
						try {
							const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
							// Pass source group identity to processTaskIpc for authorization
							await processTaskIpc(data, sourceGroup, isMain, deps);
							fs.unlinkSync(filePath);
						} catch (err) {
							logger.error(
								{ file, sourceGroup, err },
								"Error processing IPC task",
							);
							const errorDir = path.join(ipcBaseDir, "errors");
							fs.mkdirSync(errorDir, { recursive: true });
							fs.renameSync(
								filePath,
								path.join(errorDir, `${sourceGroup}-${file}`),
							);
						}
					}
				}
			} catch (err) {
				logger.error({ err, sourceGroup }, "Error reading IPC tasks directory");
			}
		}

		setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
	};

	processIpcFiles();
	logger.info("IPC watcher started (per-group namespaces)");
}

export async function processTaskIpc(
	data: {
		type: string;
		taskId?: string;
		prompt?: string;
		schedule_type?: string;
		schedule_value?: string;
		context_mode?: string;
		groupFolder?: string;
		chatJid?: string;
		targetJid?: string;
		// For register_group
		jid?: string;
		name?: string;
		folder?: string;
		trigger?: string;
		requiresTrigger?: boolean;
		containerConfig?: RegisteredGroup["containerConfig"];
		// For healer_setup
		action?: string;
		linuxUsername?: string;
		discordUserId?: string;
		repoName?: string;
		localPath?: string;
		inspectionTypes?: string[];
		schedule?: string;
		sourceName?: string;
		host?: string;
		logPath?: string;
		logPattern?: string;
		linkedRepo?: string;
	},
	sourceGroup: string, // Verified identity from IPC directory
	isMain: boolean, // Verified from directory path
	deps: IpcDeps,
): Promise<void> {
	const registeredGroups = deps.registeredGroups();

	switch (data.type) {
		case "schedule_task":
			if (
				data.prompt &&
				data.schedule_type &&
				data.schedule_value &&
				data.targetJid
			) {
				// Resolve the target group from JID
				const targetJid = data.targetJid as string;
				const targetGroupEntry = registeredGroups[targetJid];

				if (!targetGroupEntry) {
					logger.warn(
						{ targetJid },
						"Cannot schedule task: target group not registered",
					);
					break;
				}

				const targetFolder = targetGroupEntry.folder;

				// Authorization: non-main groups can only schedule for themselves
				if (!isMain && targetFolder !== sourceGroup) {
					logger.warn(
						{ sourceGroup, targetFolder },
						"Unauthorized schedule_task attempt blocked",
					);
					break;
				}

				const scheduleType = data.schedule_type as "cron" | "interval" | "once";

				let nextRun: string | null = null;
				if (scheduleType === "cron") {
					try {
						const interval = CronExpressionParser.parse(data.schedule_value, {
							tz: TIMEZONE,
						});
						nextRun = interval.next().toISOString();
					} catch {
						logger.warn(
							{ scheduleValue: data.schedule_value },
							"Invalid cron expression",
						);
						break;
					}
				} else if (scheduleType === "interval") {
					const ms = parseInt(data.schedule_value, 10);
					if (isNaN(ms) || ms <= 0) {
						logger.warn(
							{ scheduleValue: data.schedule_value },
							"Invalid interval",
						);
						break;
					}
					nextRun = new Date(Date.now() + ms).toISOString();
				} else if (scheduleType === "once") {
					const date = new Date(data.schedule_value);
					if (isNaN(date.getTime())) {
						logger.warn(
							{ scheduleValue: data.schedule_value },
							"Invalid timestamp",
						);
						break;
					}
					nextRun = date.toISOString();
				}

				const taskId =
					data.taskId ||
					`task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				const contextMode =
					data.context_mode === "group" || data.context_mode === "isolated"
						? data.context_mode
						: "isolated";
				createTask({
					id: taskId,
					group_folder: targetFolder,
					chat_jid: targetJid,
					prompt: data.prompt,
					schedule_type: scheduleType,
					schedule_value: data.schedule_value,
					context_mode: contextMode,
					next_run: nextRun,
					status: "active",
					created_at: new Date().toISOString(),
				});
				logger.info(
					{ taskId, sourceGroup, targetFolder, contextMode },
					"Task created via IPC",
				);
				deps.onTasksChanged();
			}
			break;

		case "pause_task":
			if (data.taskId) {
				const task = getTaskById(data.taskId);
				if (task && (isMain || task.group_folder === sourceGroup)) {
					updateTask(data.taskId, { status: "paused" });
					logger.info(
						{ taskId: data.taskId, sourceGroup },
						"Task paused via IPC",
					);
					deps.onTasksChanged();
				} else {
					logger.warn(
						{ taskId: data.taskId, sourceGroup },
						"Unauthorized task pause attempt",
					);
				}
			}
			break;

		case "resume_task":
			if (data.taskId) {
				const task = getTaskById(data.taskId);
				if (task && (isMain || task.group_folder === sourceGroup)) {
					updateTask(data.taskId, { status: "active" });
					logger.info(
						{ taskId: data.taskId, sourceGroup },
						"Task resumed via IPC",
					);
					deps.onTasksChanged();
				} else {
					logger.warn(
						{ taskId: data.taskId, sourceGroup },
						"Unauthorized task resume attempt",
					);
				}
			}
			break;

		case "cancel_task":
			if (data.taskId) {
				const task = getTaskById(data.taskId);
				if (task && (isMain || task.group_folder === sourceGroup)) {
					deleteTask(data.taskId);
					logger.info(
						{ taskId: data.taskId, sourceGroup },
						"Task cancelled via IPC",
					);
					deps.onTasksChanged();
				} else {
					logger.warn(
						{ taskId: data.taskId, sourceGroup },
						"Unauthorized task cancel attempt",
					);
				}
			}
			break;

		case "update_task":
			if (data.taskId) {
				const task = getTaskById(data.taskId);
				if (!task) {
					logger.warn(
						{ taskId: data.taskId, sourceGroup },
						"Task not found for update",
					);
					break;
				}
				if (!isMain && task.group_folder !== sourceGroup) {
					logger.warn(
						{ taskId: data.taskId, sourceGroup },
						"Unauthorized task update attempt",
					);
					break;
				}

				const updates: Parameters<typeof updateTask>[1] = {};
				if (data.prompt !== undefined) updates.prompt = data.prompt;
				if (data.schedule_type !== undefined)
					updates.schedule_type = data.schedule_type as
						| "cron"
						| "interval"
						| "once";
				if (data.schedule_value !== undefined)
					updates.schedule_value = data.schedule_value;

				// Recompute next_run if schedule changed
				if (data.schedule_type || data.schedule_value) {
					const updatedTask = {
						...task,
						...updates,
					};
					if (updatedTask.schedule_type === "cron") {
						try {
							const interval = CronExpressionParser.parse(
								updatedTask.schedule_value,
								{ tz: TIMEZONE },
							);
							updates.next_run = interval.next().toISOString();
						} catch {
							logger.warn(
								{ taskId: data.taskId, value: updatedTask.schedule_value },
								"Invalid cron in task update",
							);
							break;
						}
					} else if (updatedTask.schedule_type === "interval") {
						const ms = parseInt(updatedTask.schedule_value, 10);
						if (!isNaN(ms) && ms > 0) {
							updates.next_run = new Date(Date.now() + ms).toISOString();
						}
					}
				}

				updateTask(data.taskId, updates);
				logger.info(
					{ taskId: data.taskId, sourceGroup, updates },
					"Task updated via IPC",
				);
				deps.onTasksChanged();
			}
			break;

		case "refresh_groups":
			// Only main group can request a refresh
			if (isMain) {
				logger.info(
					{ sourceGroup },
					"Group metadata refresh requested via IPC",
				);
				await deps.syncGroups(true);
				// Write updated snapshot immediately
				const availableGroups = deps.getAvailableGroups();
				deps.writeGroupsSnapshot(
					sourceGroup,
					true,
					availableGroups,
					new Set(Object.keys(registeredGroups)),
				);
			} else {
				logger.warn(
					{ sourceGroup },
					"Unauthorized refresh_groups attempt blocked",
				);
			}
			break;

		case "register_group":
			// Only main group can register new groups
			if (!isMain) {
				logger.warn(
					{ sourceGroup },
					"Unauthorized register_group attempt blocked",
				);
				break;
			}
			if (data.jid && data.name && data.folder && data.trigger) {
				if (!isValidGroupFolder(data.folder)) {
					logger.warn(
						{ sourceGroup, folder: data.folder },
						"Invalid register_group request - unsafe folder name",
					);
					break;
				}
				// Defense in depth: agent cannot set isMain via IPC
				deps.registerGroup(data.jid, {
					name: data.name,
					folder: data.folder,
					trigger: data.trigger,
					added_at: new Date().toISOString(),
					containerConfig: data.containerConfig,
					requiresTrigger: data.requiresTrigger,
				});
			} else {
				logger.warn(
					{ data },
					"Invalid register_group request - missing required fields",
				);
			}
			break;

		case "healer_setup": {
			// Type-safe access to healer-specific fields
			const healerData = data as Record<string, unknown>;

			if (healerData.action === "create_profile") {
				const linuxUsername = healerData.linuxUsername as string;
				const discordUserId = healerData.discordUserId as string;
				const chatJid = healerData.chatJid as string;
				const groupFolder = healerData.groupFolder as string;

				const user = lookupLinuxUser(linuxUsername);
				if (!user) {
					await deps.sendMessage(
						chatJid,
						`Linux user "${linuxUsername}" not found on this system.`,
					);
					break;
				}

				const status = validateUserSetup(user.homeDir);
				if (status.errors.length > 0) {
					await deps.sendMessage(
						chatJid,
						`Setup issues:\n${status.errors.map((e) => `- ${e}`).join("\n")}`,
					);
					break;
				}

				const existing = getUserProfileByDiscordId(discordUserId);
				const profile: UserProfile = {
					id: existing?.id || randomUUID(),
					discordUserId,
					linuxUsername: user.username,
					uid: user.uid,
					gid: user.gid,
					homeDir: user.homeDir,
					repos: existing?.repos || [],
					remoteSources: existing?.remoteSources || [],
					createdAt: existing?.createdAt || new Date().toISOString(),
				};

				setUserProfile(profile);

				// Link the group's containerConfig to the profile
				const groups = deps.registeredGroups();
				for (const [jid, group] of Object.entries(groups)) {
					if (group.folder === groupFolder) {
						const updatedGroup = {
							...group,
							containerConfig: {
								...group.containerConfig,
								userProfileId: profile.id,
							},
						};
						deps.registerGroup(jid, updatedGroup);
						break;
					}
				}

				await deps.sendMessage(
					chatJid,
					`Profile created for ${user.username} (uid: ${user.uid}).\n` +
						`Claude auth: ✓\nGitHub CLI: ✓\n\n` +
						`Next: tell me which repos to monitor and where to find logs.`,
				);
				logger.info(
					{
						discordUserId,
						linuxUsername: user.username,
						profileId: profile.id,
					},
					"Healer profile created",
				);
			}

			if (healerData.action === "add_repo") {
				const discordUserId = healerData.discordUserId as string;
				const chatJid = healerData.chatJid as string;
				const groupFolder = healerData.groupFolder as string;
				const repoName = healerData.repoName as string;
				const localPath = healerData.localPath as string;
				const inspectionTypes = healerData.inspectionTypes as string[];
				const schedule = (healerData.schedule as string) || "0 23 * * *";

				const profile = getUserProfileByDiscordId(discordUserId);
				if (!profile) {
					await deps.sendMessage(
						chatJid,
						"No healer profile found. Run setup first.",
					);
					break;
				}

				// Check for duplicate
				if (profile.repos.find((r) => r.name === repoName)) {
					await deps.sendMessage(
						chatJid,
						`Repo "${repoName}" already configured. Remove it first to reconfigure.`,
					);
					break;
				}

				profile.repos.push({
					name: repoName,
					localPath,
					inspectionTypes: inspectionTypes as Array<
						"log-analysis" | "code-review" | "security-review"
					>,
					schedule,
					healBranchPrefix: "heal/",
				});

				setUserProfile(profile);

				// Create the scheduled heal task
				let nextRun: string | null;
				try {
					const interval = CronExpressionParser.parse(schedule, {
						tz: TIMEZONE,
					});
					nextRun = interval.next().toISOString();
				} catch {
					await deps.sendMessage(
						chatJid,
						`Invalid cron expression: ${schedule}`,
					);
					break;
				}

				const taskId = randomUUID();
				createTask({
					id: taskId,
					group_folder: groupFolder,
					chat_jid: chatJid,
					prompt: `[HEAL:${profile.id}]`,
					schedule_type: "cron",
					schedule_value: schedule,
					context_mode: "isolated",
					next_run: nextRun,
					status: "active",
					created_at: new Date().toISOString(),
				});

				deps.onTasksChanged();

				await deps.sendMessage(
					chatJid,
					`Repo "${repoName}" added with ${inspectionTypes.join(", ")} inspection.\n` +
						`Schedule: ${schedule}\n` +
						`Heal task created (ID: ${taskId.slice(0, 8)}).`,
				);
				logger.info(
					{ discordUserId, repoName, taskId, schedule },
					"Healer repo added with scheduled task",
				);
			}

			if (healerData.action === "add_log_source") {
				const discordUserId = healerData.discordUserId as string;
				const chatJid = healerData.chatJid as string;
				const sourceName = healerData.sourceName as string;
				const host = healerData.host as string;
				const logPath = healerData.logPath as string;
				const logPattern = (healerData.logPattern as string) || "*.log";
				const linkedRepo = healerData.linkedRepo as string;

				const profile = getUserProfileByDiscordId(discordUserId);
				if (!profile) {
					await deps.sendMessage(
						chatJid,
						"No healer profile found. Run setup first.",
					);
					break;
				}

				profile.remoteSources.push({
					name: sourceName,
					host,
					logPath,
					logPattern,
					linkedRepo,
				});

				setUserProfile(profile);

				await deps.sendMessage(
					chatJid,
					`Log source "${sourceName}" added.\n` +
						`Host: ${host}\nPath: ${logPath}\nPattern: ${logPattern}\n` +
						`Linked to repo: ${linkedRepo}`,
				);
				logger.info(
					{ discordUserId, sourceName, host, linkedRepo },
					"Healer log source added",
				);
			}

			break;
		}

		default:
			logger.warn({ type: data.type }, "Unknown IPC task type");
	}
}
