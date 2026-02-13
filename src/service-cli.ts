import { getServiceManagerProvider } from './service-manager.js';

type Action = 'status' | 'start' | 'stop' | 'restart';

function isAction(value: string): value is Action {
  return value === 'status' || value === 'start' || value === 'stop' || value === 'restart';
}

function printUsage(): void {
  console.log('Usage: tsx src/service-cli.ts <status|start|stop|restart> [service-name]');
}

function main(): void {
  const actionArg = process.argv[2];
  const serviceName = process.argv[3];

  if (!actionArg || !isAction(actionArg)) {
    printUsage();
    process.exit(1);
  }

  const serviceManager = getServiceManagerProvider();
  const target = serviceName || serviceManager.defaultServiceName;

  if (serviceManager.id === 'none') {
    console.error('No supported service manager was detected on this host.');
    process.exit(1);
  }

  try {
    if (actionArg === 'status') {
      const state = serviceManager.status(target);
      console.log(`${serviceManager.displayName} ${target}: ${state}`);
      process.exit(state === 'running' ? 0 : 3);
    }

    if (actionArg === 'start') {
      serviceManager.start(target);
      console.log(`Started ${target} via ${serviceManager.displayName}`);
      return;
    }

    if (actionArg === 'stop') {
      serviceManager.stop(target);
      console.log(`Stopped ${target} via ${serviceManager.displayName}`);
      return;
    }

    serviceManager.restart(target);
    console.log(`Restarted ${target} via ${serviceManager.displayName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Service command failed: ${message}`);
    process.exit(1);
  }
}

main();
