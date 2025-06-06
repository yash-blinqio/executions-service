// src/classes/ExecutionRunner.ts
import { ExecEnvVars, Execution, ExecutionStatus, Task, TaskResult } from '../models/execution.model';
import { ExecutionPodAgent } from './ExecutionPodAgent';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { KubernetesClient } from './KubernetesClient';

import { BACKEND_SOCKET_URL, FINISHED_FLOW_SIGNAL, FINISHED_SG_SIGNAL, PVC_YAML_PATH, SETUP_YAML_PATH } from '../constants';
import { generateWorkerYaml } from '../config_files/generateWorkerYaml';
import { getFlowGroupKey, getTasksArray, injectRunIdInScenarios, parsePodId } from '../utils/execData';
import { executionRunnerRegistry } from './ExecutionRunnerRegistry';
import { updateRunnerStatus } from '../utils/sse/executionStatus';
import { createRun, updateExecution } from '../utils/general';

console.log('✅ Backend is running at', BACKEND_SOCKET_URL)

export class ExecutionRunner {
  private io: SocketIOServer;
  public execution: Execution;
  private connectedAgents: Map<string, ExecutionPodAgent[]> = new Map();
  private flowQueues: Map<number, Task[][]> = new Map();
  private flowStatus: Map<number, boolean> = new Map();
  private abortExecutionController: AbortController | null = null;
  public executionStatus: ExecutionStatus;
  private runId: string | null = null;
  private execEnvVars: ExecEnvVars;

  constructor(execution: Execution, io: SocketIOServer, execEnvVars: ExecEnvVars) {
    this.execEnvVars = execEnvVars;
    this.execution = execution;
    this.io = io;
    this.initializeQueues();
    this.executionStatus = {
      'executionId': execution._id,
      'scenariosFailed': 0,
      'scenariosPassed': 0,
      'totalScenarios': execution.flows.reduce((acc, flow) => acc + flow.scenarioGroups.reduce((sum, sg) => sum + sg.scenarios.length, 0), 0),
      'startTime': new Date()
    }
  }

  public async getReportLink(): Promise<string | null> {
    if (!this.runId) {
      return null;
    }
    if (this.runId === 'loading') {
      console.log('🔄 Waiting for runId to be initialized...');
      while (this.runId === 'loading') {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return this.getReportLink();
    }
    const env = process.env.NODE_ENV_BLINQ || 'prod';
    const link = env === 'prod' ?
      `https://www.app.blinq.io/${this.execution.projectId}/run-report/${this.runId}` :
      `https://www.${env}.app.blinq.io/${this.execution.projectId}/run-report/${this.runId}`;
    return link;
  }

  private simulateMockExecution = async () => {
    const id = setInterval(() => console.log('🧪 Mock execution running...'), 5000);
    let duration = this.executionStatus.totalScenarios * 5000; // Simulate 2 seconds per scenario
    const interval = setInterval(() => {
      this.updateStatus(Math.random() > 0.5);
    }, 5000)
    await new Promise((res) => setTimeout(res, duration));
    clearInterval(interval);
    clearInterval(id);
    console.log('🧪 Mock execution finished')

    this.execution.running = false;
    await this.execution.save();
    // await updateExecution(this.execution._id, {
    //   key: 'running',
    //   value: false,
    // });
  }

  private getActiveGroupIndex = (flowIndex: number): number => {
    for (let [id, queue] of this.flowQueues.entries()) {
      console.log(`🚀 Flow ${id} -> `, JSON.stringify(queue, null, 2));
    }
    const flowQueue = this.flowQueues.get(flowIndex);
    if (flowQueue!.length == 0) {
      return FINISHED_FLOW_SIGNAL;
    }
    const sgTasks = flowQueue![0];
    const id = sgTasks[0].id;
    //? taskId structure is `task-flow${flowIndex}-sg${groupIndex}-f${scenario.featureIndex}-s${scenario.scenarioIndex}`
    return Number(id.split('-')[2].split('sg')[1]); //? extract group index from taskId
  }

  private launchPodsForActiveGroup = async (flowIndex: number) => {
    const EXTRACT_DIR = this.execution.projectId;
    const BLINQ_TOKEN = this.execEnvVars.BLINQ_TOKEN;
    const k8sClient = new KubernetesClient();

    const activeGroupIndex = this.getActiveGroupIndex(flowIndex);
    if (activeGroupIndex === FINISHED_FLOW_SIGNAL) {
      this.ifExecutionFinished();
      return FINISHED_FLOW_SIGNAL;
    }

    const allocatedThreads = this.execution.flows[flowIndex].scenarioGroups[activeGroupIndex].threadCount;
    const flowGroupKey = getFlowGroupKey(this.execution._id, flowIndex, activeGroupIndex);
    const EXECUTION_ID = this.execution._id;
    for (let i = 0; i < allocatedThreads; i++) {
      const POD_ID = `${flowGroupKey}.w${i}`;
      const podSpec = generateWorkerYaml({
        EXECUTION_ID,
        EXTRACT_DIR,
        POD_ID,
        BLINQ_TOKEN,
        SOCKET_URL: BACKEND_SOCKET_URL,
      });
      console.log(`🚀 Launching pod ${POD_ID}`);
      try {
        await k8sClient.createPodFromYaml(podSpec);
      } catch (error) {
        console.error(`❌ Failed to create worker pod ${POD_ID}:`, error);
        console.log(`🛑 Stopping execution due to pod creation failure`);
        this.stop(true);
        return -1;
      }
    }
    return flowIndex;
  }

  private agentCleanup = async (k8sClient: KubernetesClient, agent: ExecutionPodAgent) => {
    console.log('🧹 Cleaning up agent:', agent.id);
    agent.socket.emit('shutdown');
    const workerId = 'worker-' + agent.id;
    try {
      const podExists = await k8sClient.doesPodExist(workerId);
      if(podExists) {
        await k8sClient.deletePod(workerId);
      }
    } catch (err: any) {
      console.warn(`⚠️ Failed to check existence/delete pod ${workerId}:`, err.message);
    }
  }



  private async initializeQueues() {
    this.runId = 'loading';
    const runId = await createRun(this.execution.name, process.env.BLINQ_TOKEN!, process.env.NODE_ENV_BLINQ || 'prod');
    
    if(!runId) return;
    
    this.runId= runId;


    this.execution.flows.forEach((flow, flowIndex) => {
      const q = this.flowQueues.get(flowIndex) || [];
      flow.scenarioGroups.forEach((group, groupIndex) => {
        injectRunIdInScenarios(group.scenarios, runId, this.execution.projectId);
        q.push(getTasksArray(group.scenarios, flowIndex, groupIndex));
      });
      this.flowQueues.set(flowIndex, q);
      this.flowStatus.set(flowIndex, true);
    });
  }

  public async stop(deleteWorkerPods = false) {
    if (!this.execution.running) {
      return;
    }
    console.log(`🛑 Stopping execution ${this.execution._id}...`);

    this.execution.running = false;
    this.execution.save();

    const k8sClient = new KubernetesClient();

    for (const [groupKey, agents] of this.connectedAgents.entries()) {
      agents.forEach(agent => {
        console.log(`🗑️ Cleaning pods for group ${agent.id}`);
        this.agentCleanup(k8sClient, agent);
      });
    }

    const setupPodName = `setup-${this.execution._id}`
    try {
      const podStatus = await k8sClient.getPodStatus(setupPodName);
      if (podStatus) {
        await k8sClient.deletePod(setupPodName);
      } else {
      }
    } catch (err: any) {
      console.warn(`⚠️ Failed to delete setup pod`, err.message);
    }

    const { executionRunnerRegistry } = await import('./ExecutionRunnerRegistry');
    executionRunnerRegistry.remove(this.execution._id.toString());
  }

  public async start(mock = false) {
    this.executionStatus.startTime = new Date();
    executionRunnerRegistry.set(this.execution._id.toString(), this);

    updateRunnerStatus(this.execution._id, this.execution.projectId, this.executionStatus);

    if (mock) {
      this.simulateMockExecution()
      return;
    }

    await this.spawnPods();
  }
  // ✅ Works
  private async spawnPods() {
    const k8sClient = new KubernetesClient();
    const setupPodName = `setup-${this.execution._id}`;
    const EXECUTION_ID = this.execution._id;
    const EXTRACT_DIR = this.execution.projectId;
    const BLINQ_TOKEN = this.execEnvVars.BLINQ_TOKEN!;
    const NODE_ENV_BLINQ = this.execEnvVars.NODE_ENV_BLINQ;

    try {
      await k8sClient.applyManifestFromFile(PVC_YAML_PATH, {
        EXECUTION_ID,
      });
      if (!(this.execEnvVars.SKIP_SETUP === 'true')) {
        await k8sClient.applyManifestFromFile(SETUP_YAML_PATH, {
          EXECUTION_ID,
          EXTRACT_DIR,
          BLINQ_TOKEN,
          BUILD_ID: String(new Date().getTime()),
          NODE_ENV_BLINQ,
        });

        await k8sClient.waitForPodCompletion(setupPodName);
        await k8sClient.deletePod(setupPodName);
      } else {
        console.log(`⚠️ Skipping setup pod for ${setupPodName}`);
      }
    } catch (error) {
      console.error('❌ Failed to spawn setup pod or PVC:', error);
      this.stop();
      return;
    }

    for (let flowIndex = 0; flowIndex < this.execution.flows.length; flowIndex++) {
      {
        this.launchPodsForActiveGroup(flowIndex);
      }
    }
  }

  private ifExecutionFinished() {
    console.log(`🔍 Checking if execution ${this.execution._id} is finished...`);
    for (const [flowIndex, flowQueue] of this.flowQueues.entries()) {
      console.log(`📭 Flow ${flowIndex + 1} queue is`,
        JSON.stringify(flowQueue, null, 2)
      );
      if (flowQueue.length !== 0) {
        for (const sgTasks of flowQueue) {
          if (sgTasks.length > 0) {
            return;
          }
        }
      }
    }
    this.stop(true);
    console.log(`✅ Execution ${this.execution._id} finished successfully!`);
  }

  private updateStatus(wasSuccessful: boolean) {
    if (wasSuccessful) {
      this.executionStatus.scenariosPassed++;
    } else {
      this.executionStatus.scenariosFailed++;
    }
    updateRunnerStatus(this.execution._id, this.execution.projectId, this.executionStatus);
  }

  public handlePodConnection(socket: Socket, parsed: ReturnType<typeof parsePodId>) {
    const { flowIndex, groupIndex, executionId, workerNumber } = parsed;
    const podId = socket.handshake.query.podId as string;
    const flowGroupKey = getFlowGroupKey(this.execution._id, flowIndex, groupIndex);

    console.log(`🔌 Pod ${podId} connected for tasks in ${this.execution.name} (Flow ${flowIndex + 1}, SG ${groupIndex + 1})`);
    const agent = new ExecutionPodAgent(podId, socket);
    const currPodsForThisGroup = this.connectedAgents.get(flowGroupKey) || [];
    this.connectedAgents.set(flowGroupKey, [...currPodsForThisGroup, agent]);

    socket.on('ready', async (e: any) => {
      // console.log('💤 Inducing sleep for 10 seconds');
      // await new Promise(resolve => setTimeout(resolve, 20000));

      const flowQueue = this.flowQueues.get(flowIndex);

      if (!flowQueue || flowQueue.length === 0) {
        console.log(`📭 No tasks left for Flow ${flowIndex + 1}`);

        this.agentCleanup(new KubernetesClient(), agent);
        this.ifExecutionFinished()
        return;
      }

      if (!this.flowStatus.get(flowIndex)) {
        console.log(`📭 Flow ${flowIndex + 1} is no longer allowed to run because of a failed group, preventing further groups' execution`);

        this.agentCleanup(new KubernetesClient(), agent);
        this.ifExecutionFinished()

        return;
      }

      const sgTasks = flowQueue[0];
      //? if the group is finished, we can move to the next group by cleaning up the current group and initiating the next group
      if (sgTasks.length === 0) {
        console.log(`📭 No tasks left for Group ${groupIndex} of Flow ${flowIndex + 1}.`);

        const remainingPodsForThisGroup = (this.connectedAgents.get(flowGroupKey) || []).filter((a) => a.id !== podId);
        this.connectedAgents.set(flowGroupKey, remainingPodsForThisGroup);
        //? If this is the last pod in the group & the flow is still allowed to run & the execution is running
        //? then we can move to the next group
        if (remainingPodsForThisGroup.length === 0 && this.flowStatus.get(flowIndex) && this.execution.running) {
          flowQueue.shift();
          console.log(`🪦 Last Pod is trying to spawn the pods for the next group`);
          await this.launchPodsForActiveGroup(flowIndex);
        }

        this.agentCleanup(new KubernetesClient(), agent);
        return;
      } else {
        const task = sgTasks.shift();
        agent.assignTask(task!);
      }
    });

    socket.on('task-complete', (result: TaskResult) => {
      const wasSuccessful = result.exitCode === 0;
      if (wasSuccessful) {
        console.log(`✅ Pod ${podId} completed task ${result.taskId}`);
        this.updateStatus(true);
      } else {
        console.error(`❌ Pod ${podId} failed task ${result.taskId}`);
        const flowIndex = Number(result.taskId.split('-')[1].split('flow')[1]);
        if (result.task.retriesRemaining > 0) {
          result.task.retriesRemaining--;
          console.log(`🔄 Retrying task ${result.taskId}, (${result.task.retriesRemaining} retries left)`);
          const flowQueue = this.flowQueues.get(flowIndex);
          if (flowQueue) {
            flowQueue[0].push(result.task);
          }
        } else {
          console.error(`❌ Task ${result.taskId} failed and has no retries left, halting execution for Flow ${flowIndex + 1}`);
          this.flowStatus.set(flowIndex, false);
          this.updateStatus(false);

          this.ifExecutionFinished()
          this.agentCleanup(new KubernetesClient(), agent);
        }
      }
    });

    socket.on('cleanup', (podId) => {
      const k8sClient = new KubernetesClient();
      this.agentCleanup(k8sClient, agent);
    });

    socket.on('connect_error', (err) => {
      console.error('❌ Socket connection error:', err.message);
    });

    socket.on('disconnect', (reason) => {
      console.warn('⚠️ Socket disconnected:', reason);
      this.connectedAgents.delete(podId);
    });
  }

}
