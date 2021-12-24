import * as vscode from "vscode";
import { CancellationToken, Disposable, EventEmitter, OutputChannel, ProgressLocation, StatusBarAlignment, Uri } from "vscode";
import client from "../core/client";
import { PATH, PROP, RESOURCE_TYPE } from "../core/constants";
import { executeQuery, publishJcrContent, PublishOptions } from "../core/repo";
import { ReplicationLogStream } from "../core/system";
import { createNotifier, getHostFromUrl, makeUri, onInterval } from "../util";

const onDidCompletePublishEmitter = new EventEmitter<void>();
const onDidCompletePublish = onDidCompletePublishEmitter.event;

const publishQueue: Promise<void>[] = [];
const publishInProgressHint = vscode.window.createStatusBarItem(StatusBarAlignment.Left);
publishInProgressHint.text = '$(sync~spin) Publishing';

const symbols = {
    'success': '\u2713',
    'failed': '\u2717',
    'queued': 'Q'
};

let outputChannel: OutputChannel;

interface RelicationQueueItem {
    id: string;
    path: string;
    time: number;
    userid: string;
    type: string;
    size: number;
    lastProcessed: number;
    numProcessed: number;
}

interface ReplicationAgentStatus {
    metaData: {
        queueStatus: {
            agentName: string;
            agentId: string;
            isBlocked: boolean;
            isPaused: boolean;
            time: number;
            processingSince: number;
            lastProcessTime: number;
            nextRetryPeriod: number;
        }
    }
    queue: RelicationQueueItem[]
}

function formatProgress(count: number, total: number) {
    let len = Math.ceil(Math.log10(total));
    return `[${(' '.repeat(len) + count).slice(-len)}/${total}]`;
}

async function getPublishAgent(host: string) {
    let [agent] = await executeQuery(host, {
        path: PATH.replication,
        where: {
            [PROP.slingResourceType]: RESOURCE_TYPE.cqAgent,
            serializationType: 'durbo',
            enabled: true
        }
    });
    if (!agent) {
        throw new Error(`There is no active publish agent on ${host}`);
    }
    return Uri.joinPath(makeUri(host, agent.path), '..');
}

async function getPublishAgentStatus(agentUri: Uri) {
    return await client.fetchJSON(Uri.joinPath(agentUri, 'jcr:content.queue.json')) as ReplicationAgentStatus;
}

export async function startPublishTask(jcrPath: Uri, options?: PublishOptions) {
    const [onFinalize, finalize] = createNotifier<void>();
    publishQueue.push(onFinalize);
    onFinalize.then(() => {
        publishQueue.shift();
        onDidCompletePublishEmitter.fire();
        if (!publishQueue.length) {
            publishInProgressHint.hide();
        }
    });
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('AEM Explorer (Replication)');
    }
    outputChannel.show();
    publishInProgressHint.show();

    if (publishQueue.length === 1) {
        outputChannel.clear();
    } else {
        let cancellationToken: CancellationToken;
        await vscode.window.withProgress({ location: ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
            const getMessage = () => `Replication: waiting previous job to complete (${publishQueue.indexOf(onFinalize) + 1} of ${publishQueue.length})`;
            cancellationToken = token;
            progress.report({ message: getMessage() });
            return new Promise<void>(resolve => {
                onDidCompletePublish(() => {
                    progress.report({ message: getMessage() });
                    if (publishQueue[0] === onFinalize) {
                        resolve();
                    }
                });
            });
        });
        if (cancellationToken!.isCancellationRequested) {
            finalize();
            return;
        }
        outputChannel.appendLine('');
    }
    outputChannel.appendLine(`Publishing ${jcrPath.toString(true)}`);
    for (let i of ['subtree', 'includeNewItems', 'includeUnmodifiedItems', 'includeDeactivatedItems']) {
        outputChannel.appendLine(`  ${i}: ${options?.[i as keyof PublishOptions] || false}`);
    }
    outputChannel.appendLine('');

    let result: Record<string, 'success' | 'failed' | 'queued'> = {};
    let paths: string[] = [];
    let ignoredCount = 0;
    let disposables: Disposable[] = [];
    try {
        let agentUri = await getPublishAgent(getHostFromUrl(jcrPath));
        let stream = new ReplicationLogStream(agentUri);
        let queuedItems: Record<string, any> = {};
        let startReport = false;
        let count = 0;

        disposables.push(stream);
        for (let item of (await getPublishAgentStatus(agentUri)).queue) {
            queuedItems[item.id] = true;
        }
        await stream.ready;
        await new Promise<void>(async (resolve) => {
            // start monitoring replication log and queue before calling api
            // as items may already be processing before api call is returned
            stream.onDidAppendLog(entries => {
                for (let { level, message } of entries) {
                    let path = /^>> Path: (.+)/.test(message) && RegExp.$1;
                    if (path && !result[path]) {
                        if (!startReport) {
                            result[path] = level === 'INFO' ? 'success' : 'failed';
                        } else if (paths.includes(path)) {
                            result[path] = level === 'INFO' ? 'success' : 'failed';
                            outputChannel.appendLine(`${formatProgress(++count, paths.length)} ${symbols[result[path]]} ${path}`);
                            if (count === paths.length) {
                                resolve();
                            }
                        }
                    }
                }
            });
            disposables.push(
                onInterval(2000, async () => {
                    let { metaData, queue } = await getPublishAgentStatus(agentUri);
                    if (metaData.queueStatus.isBlocked || metaData.queueStatus.isPaused) {
                        for (let { id, path } of queue) {
                            if (!queuedItems[id]) {
                                queuedItems[id] = true;
                                if (!result[path] && startReport) {
                                    outputChannel.appendLine(`${formatProgress(++count, paths.length)} ${symbols[result[path]]} ${path}`);
                                    if (count === paths.length) {
                                        resolve();
                                    }
                                }
                                result[path] = 'queued';
                            }
                        }
                    }
                })
            );

            for (let { path, activate } of await publishJcrContent(jcrPath, options)) {
                if (activate) {
                    paths.push(path);
                } else {
                    ignoredCount++;
                    outputChannel.appendLine(`Skipped: ${path}`);
                }
            }
            if (!paths.length) {
                resolve();
                return;
            }
            // collect already processed items before api call has returned
            // and early return if all items are processed
            for (let i in result) {
                if (!paths.includes(i)) {
                    delete result[i];
                } else {
                    outputChannel.appendLine(`${formatProgress(++count, paths.length)} ${symbols[result[i]]} ${i}`);
                }
            }
            if (count === paths.length) {
                resolve();
                return;
            }
            startReport = true;
        });
    } finally {
        disposables.forEach(v => v.dispose());
        finalize();
    }

    outputChannel.appendLine('');
    if (!paths.length) {
        outputChannel.appendLine('Everything is up-to-date');
    } else {
        let failedCount = Object.values(result).filter(v => v === 'failed').length;
        let queuedCount = Object.values(result).filter(v => v === 'queued').length;
        outputChannel.appendLine(`${paths.length - failedCount - queuedCount} published, ${queuedCount} queued, ${failedCount} failed, ${ignoredCount} skipped`);
    }
}
