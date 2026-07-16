(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RecordingStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FORMAT = 'recording-chunks-v1';
    const MANIFEST_PREFIX = '__recording_manifest_';
    const CHUNK_PREFIX = '__recording_chunk_';
    const DEFAULT_IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;

    function assertId(id) {
        if (!/^[A-Za-z0-9_-]{8,160}$/.test(String(id || ''))) {
            throw new Error('Invalid recording id');
        }
        return String(id);
    }

    function manifestKey(id) {
        return MANIFEST_PREFIX + assertId(id);
    }

    function chunkKey(id, index) {
        if (!Number.isInteger(index) || index < 0) throw new Error('Invalid recording chunk index');
        return CHUNK_PREFIX + assertId(id) + '_' + String(index).padStart(8, '0');
    }

    function asBlob(value, mimeType) {
        if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            return new Blob([value], { type: mimeType || 'application/octet-stream' });
        }
        throw new Error('Recording chunk must be a Blob or binary buffer');
    }

    function chunkNamespace(manifest) {
        return assertId((manifest && manifest.chunkNamespace) || (manifest && manifest.id));
    }

    class RecordingStore {
        constructor(adapter, options) {
            if (!adapter || typeof adapter.get !== 'function' || typeof adapter.put !== 'function' ||
                typeof adapter.putPair !== 'function' || typeof adapter.delete !== 'function' ||
                typeof adapter.keys !== 'function') {
                throw new Error('RecordingStore requires a transactional storage adapter');
            }
            this.adapter = adapter;
            this.importChunkBytes = Math.max(256 * 1024,
                Number(options && options.importChunkBytes) || DEFAULT_IMPORT_CHUNK_BYTES);
            this.manifests = new Map();
            this.queues = new Map();
        }

        async begin(meta) {
            const id = assertId(meta && meta.id);
            const existing = await this.getManifest(id);
            if (existing && existing.status !== 'deleting') return existing;
            const now = new Date().toISOString();
            const manifest = {
                format: FORMAT,
                version: 1,
                id,
                status: 'recording',
                mimeType: String(meta.mimeType || 'audio/webm'),
                chunkCount: 0,
                byteLength: 0,
                duration: 0,
                startedAt: meta.startedAt || now,
                stoppedAt: null,
                updatedAt: now,
                material: Object.assign({}, meta.material || {})
            };
            await this.adapter.put(manifestKey(id), manifest);
            this.manifests.set(id, manifest);
            return manifest;
        }

        _enqueue(id, operation) {
            id = assertId(id);
            const previous = this.queues.get(id) || Promise.resolve();
            const current = previous.catch(function () {}).then(operation);
            this.queues.set(id, current);
            current.finally(() => {
                if (this.queues.get(id) === current) this.queues.delete(id);
            }).catch(function () {});
            return current;
        }

        async drain(id) {
            const pending = this.queues.get(assertId(id));
            if (pending) await pending;
        }

        append(id, value) {
            id = assertId(id);
            return this._enqueue(id, async () => {
                const manifest = await this.getManifest(id);
                if (!manifest) throw new Error('Recording manifest is missing');
                if (manifest.status === 'deleting' || manifest.status === 'complete') {
                    throw new Error('Recording is not writable');
                }
                const blob = asBlob(value, manifest.mimeType);
                if (!blob.size) return { index: manifest.chunkCount, manifest };
                const index = manifest.chunkCount;
                const next = Object.assign({}, manifest, {
                    chunkCount: index + 1,
                    byteLength: manifest.byteLength + blob.size,
                    updatedAt: new Date().toISOString()
                });
                await this.adapter.putPair(chunkKey(id, index), blob, manifestKey(id), next);
                this.manifests.set(id, next);
                return { index, bytes: blob.size, manifest: next };
            });
        }

        async complete(id, patch) {
            id = assertId(id);
            await this.drain(id);
            const manifest = await this.getManifest(id);
            if (!manifest) throw new Error('Recording manifest is missing');
            const next = Object.assign({}, manifest, patch || {}, {
                status: 'complete',
                stoppedAt: (patch && patch.stoppedAt) || new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            await this.adapter.put(manifestKey(id), next);
            this.manifests.set(id, next);
            return next;
        }

        async markMetadataPending(id, pending) {
            id = assertId(id);
            await this.drain(id);
            const manifest = await this.getManifest(id);
            if (!manifest) return null;
            const next = Object.assign({}, manifest, {
                metadataPending: pending !== false,
                updatedAt: new Date().toISOString()
            });
            await this.adapter.put(manifestKey(id), next);
            this.manifests.set(id, next);
            return next;
        }

        async getManifest(id) {
            id = assertId(id);
            if (this.manifests.has(id)) return this.manifests.get(id);
            const manifest = await this.adapter.get(manifestKey(id));
            if (!manifest || manifest.format !== FORMAT || manifest.id !== id) return null;
            this.manifests.set(id, manifest);
            return manifest;
        }

        async getChunk(id, index) {
            const manifest = await this.getManifest(id);
            if (!manifest || index < 0 || index >= manifest.chunkCount) return null;
            return this.adapter.get(chunkKey(chunkNamespace(manifest), index));
        }

        async getBlob(id) {
            id = assertId(id);
            await this.drain(id);
            const manifest = await this.getManifest(id);
            if (!manifest) return null;
            const parts = [];
            let bytes = 0;
            const namespace = chunkNamespace(manifest);
            for (let index = 0; index < manifest.chunkCount; index++) {
                const part = await this.adapter.get(chunkKey(namespace, index));
                if (part == null) throw new Error('Recording chunk ' + index + ' is missing');
                const blob = asBlob(part, manifest.mimeType);
                parts.push(blob);
                bytes += blob.size;
            }
            if (bytes !== manifest.byteLength) throw new Error('Recording byte length does not match manifest');
            return new Blob(parts, { type: manifest.mimeType || 'audio/webm' });
        }

        async importBlob(meta, value) {
            const blob = asBlob(value, meta && meta.mimeType);
            const manifest = await this.begin(meta);
            if (manifest.status === 'complete') return manifest;
            if (manifest.chunkCount || manifest.byteLength) {
                throw new Error('Refusing to overwrite a partial recording import');
            }
            for (let offset = 0; offset < blob.size; offset += this.importChunkBytes) {
                await this.append(manifest.id, blob.slice(offset, Math.min(blob.size, offset + this.importChunkBytes), blob.type));
            }
            return this.complete(manifest.id, { duration: Number(meta.duration) || 0 });
        }

        async listManifests() {
            const keys = await this.adapter.keys();
            const manifests = [];
            for (const key of keys) {
                if (typeof key !== 'string' || !key.startsWith(MANIFEST_PREFIX)) continue;
                const id = key.slice(MANIFEST_PREFIX.length);
                try {
                    const manifest = await this.getManifest(id);
                    if (manifest) manifests.push(manifest);
                } catch (e) {}
            }
            manifests.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
            return manifests;
        }

        async restore(manifest, chunkLoader) {
            const id = assertId(manifest && manifest.id);
            if (!manifest || manifest.format !== FORMAT || !Number.isInteger(manifest.chunkCount)) {
                throw new Error('Invalid remote recording manifest');
            }
            const old = await this.getManifest(id);
            const stageId = 'restore_' + Date.now().toString(36) + '_' +
                Math.random().toString(36).slice(2, 12);
            const now = new Date().toISOString();
            const staged = {
                format: FORMAT,
                version: 1,
                id: stageId,
                status: 'staging',
                stagingFor: id,
                mimeType: String(manifest.mimeType || 'audio/webm'),
                chunkCount: 0,
                byteLength: 0,
                duration: 0,
                startedAt: manifest.startedAt || now,
                stoppedAt: null,
                updatedAt: now,
                material: Object.assign({}, manifest.material || {})
            };
            await this.adapter.put(manifestKey(stageId), staged);
            this.manifests.set(stageId, staged);
            try {
                for (let index = 0; index < manifest.chunkCount; index++) {
                    const part = await chunkLoader(index);
                    if (part == null) throw new Error('Remote recording chunk ' + index + ' is missing');
                    await this.append(stageId, part);
                }
                const completedStage = await this.complete(stageId, {
                    duration: Number(manifest.duration) || 0,
                    stoppedAt: manifest.stoppedAt,
                    material: Object.assign({}, manifest.material || {})
                });
                if (completedStage.byteLength !== manifest.byteLength) {
                    throw new Error('Remote recording size verification failed');
                }

                // A single manifest write is the commit point. Until it succeeds,
                // readers continue to see the old generation untouched.
                const local = Object.assign({}, completedStage, manifest, {
                    id,
                    format: FORMAT,
                    status: 'complete',
                    chunkNamespace: stageId,
                    chunkCount: completedStage.chunkCount,
                    byteLength: completedStage.byteLength,
                    updatedAt: new Date().toISOString()
                });
                delete local.stagingFor;
                // Remove the staging manifest before publishing the pointer. A crash
                // can then leave only unreachable staging chunks, never two manifests
                // that could race cleanup against the committed generation.
                await this.adapter.delete(manifestKey(stageId));
                this.manifests.delete(stageId);
                await this.adapter.put(manifestKey(id), local);
                this.manifests.set(id, local);

                // Old chunks are unreachable after the commit and can be reclaimed
                // best-effort without endangering the newly restored generation.
                if (old) {
                    try {
                        const oldNamespace = chunkNamespace(old);
                        for (let index = 0; index < old.chunkCount; index++) {
                            await this.adapter.delete(chunkKey(oldNamespace, index)).catch(function () {});
                        }
                        if (oldNamespace !== id && oldNamespace !== stageId) {
                            await this.adapter.delete(manifestKey(oldNamespace)).catch(function () {});
                        }
                    } catch (e) {
                        // Orphan cleanup can be retried later; the committed generation is valid.
                    }
                }
                return local;
            } catch (error) {
                await this.remove(stageId).catch(function () {});
                throw error;
            }
        }

        async remove(id) {
            id = assertId(id);
            await this.drain(id);
            const manifest = await this.getManifest(id);
            if (!manifest) return;
            const deleting = Object.assign({}, manifest, { status: 'deleting', updatedAt: new Date().toISOString() });
            await this.adapter.put(manifestKey(id), deleting);
            this.manifests.set(id, deleting);
            const namespace = chunkNamespace(manifest);
            for (let index = 0; index < manifest.chunkCount; index++) {
                await this.adapter.delete(chunkKey(namespace, index));
            }
            await this.adapter.delete(manifestKey(id));
            if (namespace !== id) await this.adapter.delete(manifestKey(namespace)).catch(function () {});
            this.manifests.delete(id);
            this.manifests.delete(namespace);
        }
    }

    return {
        FORMAT,
        MANIFEST_PREFIX,
        CHUNK_PREFIX,
        manifestKey,
        chunkKey,
        RecordingStore
    };
});
