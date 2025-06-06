// src/classes/KubernetesClient.ts
import * as k8s from '@kubernetes/client-node';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import logger from '../utils/logger';

export class KubernetesClient {
  private kc: k8s.KubeConfig;
  private k8sApi: k8s.CoreV1Api;
  private batchApi: k8s.BatchV1Api;
  private namespace = 'default';

  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
  }

  async deleteCronJob(name: string, namespace = 'default') {
    return this.batchApi.deleteNamespacedCronJob({ name, namespace });
  }


  async createPodFromYaml(yamlContent: string) {
    const manifest = yaml.load(yamlContent) as k8s.V1Pod;

    if (!manifest || !manifest.metadata?.name) {
      throw new Error('❌ Invalid pod manifest.');
    }

    try {
      await this.k8sApi.createNamespacedPod({
        namespace: 'default',
        body: manifest
      });
      console.log(`⭐ Created pod ${manifest.metadata.name}`);
    } catch (err: any) {
      logger.error('❌ Failed to create pod:', err.body || err.message);
      throw err;
    }
  }

  async getPodStatus(name: string) {
    try {
      const res = await this.k8sApi.readNamespacedPodStatus({
        name,
        namespace: this.namespace
      });
      return res.status ? res.status.phase : null; // Return pod phase if exists, null otherwise
    } catch (err: any) {
      const reason = this.extractReason(err);
      if (reason === 'NotFound') {
        return null;
      }
      throw err; // Rethrow error if it's something else
    }
  }

  public async doesPodExist(podName: string): Promise<boolean> {
    try {
      await this.k8sApi.readNamespacedPod({
        name: podName,
        namespace: this.namespace
      });
      return true;
    } catch (err: any) {
      const reason = this.extractReason(err);
      if (reason === 'NotFound') {
        return false;
      }
      throw err; // rethrow if it’s a different error
    }
  }

  async applyManifestFromFile(filePath: string, vars: Record<string, string>) {
    let content = fs.readFileSync(filePath, 'utf-8');
    for (const [key, value] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value); // ${KEY}
      content = content.replace(new RegExp(`<${key}>`, 'g'), value);       // <KEY>
    }

    const obj = k8s.loadYaml(content) as k8s.V1PersistentVolumeClaim | k8s.V1Pod;
    if (!obj.kind) {
      throw new Error('Manifest is missing `kind` field.');
    }

    console.log(`🔍 Applying manifest for ${obj.kind}...`);

    switch (obj.kind) {
      case 'PersistentVolumeClaim':
        try {
          return await this.k8sApi.createNamespacedPersistentVolumeClaim({
            namespace: this.namespace,
            body: obj as k8s.V1PersistentVolumeClaim
          });
        } catch (err: any) {
          const reason = this.extractReason(err);
          if (reason === 'AlreadyExists') {
            console.log(`⚠️ PVC ${obj.metadata?.name} already exists, skipping creation.`);
            return;
          }
          throw err;
        }

      case 'Pod':
        try {
          return await this.k8sApi.createNamespacedPod({
            namespace: this.namespace,
            body: obj as k8s.V1Pod
          });
        } catch (err: any) {
          const reason = this.extractReason(err);
          if (reason === 'AlreadyExists') {
            console.log(`⚠️ Pod ${obj.metadata?.name} already exists, skipping creation.`);
            return;
          }
          throw err;
        }

      default:
        throw new Error(`Unsupported kind: ${obj.kind}`);
    }
  }

  public async applyManifestFromYaml(yamlString: string) {
    const documents = yaml.loadAll(yamlString);

    for (const doc of documents) {
      if (!this.isKubernetesResource(doc)) continue;

      const kind = doc.kind;
      const metadata = doc.metadata || {};
      const namespace = metadata.namespace || 'default';

      switch (kind) {
        case 'CronJob':
          try {
            await this.batchApi.createNamespacedCronJob({
              namespace,
              body: doc as k8s.V1CronJob,
            });
          } catch (err: any) {
            const reason = this.extractReason(err);
            if (reason === 'AlreadyExists') {
              console.log(`⚠️ Cronjob already exists, skipping creation.`);
              return;
            }
            throw err;
          }
          break;

        default:
          throw new Error(`Unsupported kind in YAML: ${kind}`);
      }

    }
  }

  async deletePod(name: string) {
    console.log(`🗑️ Deleting pod ${name}...`);
    await this.k8sApi.deleteNamespacedPod({
      name,
      namespace: this.namespace
    });
    console.log(`✅ Pod ${name} deleted.`);
  }

  async deletePVC(name: string) {
    await this.k8sApi.deleteNamespacedPersistentVolumeClaim({
      name,
      namespace: this.namespace
    });
  }

  async waitForPodCompletion(podName: string, timeoutMs = 500000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const res = await this.k8sApi.readNamespacedPodStatus({
        name: podName,
        namespace: this.namespace
      });

      const phase = res.status?.phase;
      console.log(`🔄 Pod ${podName} status: ${phase}`);

      if (phase === 'Succeeded') {
        console.log(`✅ Setup pod ${podName} completed successfully.`);
        return;
      }

      if (phase === 'Failed') {
        throw new Error(`❌ Setup pod ${podName} failed.`);
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new Error(`⏰ Timeout waiting for setup pod ${podName}`);
  }

  private isKubernetesResource(doc: any): doc is { kind: string; metadata?: { namespace?: string } } {
    return typeof doc === 'object' && doc !== null && typeof doc.kind === 'string';
  }

  private extractReason(err: any): string {
    try {
      const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
      return body?.reason || '';
    } catch {
      return '';
    }
  }
}
