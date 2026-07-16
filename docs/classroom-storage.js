(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ClassroomStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const NOTE_FORMAT = 'classroom-note-v1';
    const NOTE_CONTENT_PREFIX = 'classroom_note_';

    function assertId(id) {
        const value = String(id || '');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
            throw new Error('Invalid classroom note id');
        }
        return value;
    }

    function noteContentKey(id) {
        return NOTE_CONTENT_PREFIX + assertId(id);
    }

    function deepClone(value) {
        if (Array.isArray(value)) return value.map(deepClone);
        if (!value || typeof value !== 'object') return value;
        if (Object.prototype.toString.call(value) === '[object Date]') {
            return new Date(value.getTime());
        }
        const copy = {};
        Object.keys(value).forEach(key => { copy[key] = deepClone(value[key]); });
        return copy;
    }

    function removeTransientPayloads(value) {
        if (Array.isArray(value)) {
            value.forEach(removeTransientPayloads);
            return;
        }
        if (!value || typeof value !== 'object') return;
        delete value.data;
        delete value._contentCache;
        Object.keys(value).forEach(key => removeTransientPayloads(value[key]));
    }

    function isRecording(material) {
        return !!material && material.type === 'recording';
    }

    // Recording metadata keeps its existing rule: absence of an affirmative
    // commit marker means the remote manifest is not yet a safe source.
    function isMaterialCloudPending(material) {
        if (!material) return false;
        if (isRecording(material)) return material.recordingCloudCommitted !== true ||
            material.recordingMetadataCloudCommitted !== true;
        return material.assetCloudCommitted === false ||
            material.assetMetadataCloudCommitted === false;
    }

    function isNoteContentCloudPending(note) {
        return !!(note && note.contentKey &&
            (note.contentCloudCommitted === false || note.contentMetadataCloudCommitted === false));
    }

    function stripClassroomData(classroom, forCloud) {
        if (classroom == null) return classroom;
        const copy = deepClone(classroom);
        removeTransientPayloads(copy);

        ['courses', 'seminars'].forEach(listKey => {
            (copy[listKey] || []).forEach(folder => {
                (folder.sessions || []).forEach(session => {
                    let materials = session.sourceFolder || [];
                    let notes = session.notes || [];
                    if (forCloud) {
                        materials = materials.filter(material => isRecording(material)
                            ? material.recordingCloudCommitted === true
                            : material.assetCloudCommitted !== false);
                        notes = notes.filter(note =>
                            !(note && note.contentKey && note.contentCloudCommitted === false));
                        // The outbound copy represents the metadata commit that is about to
                        // happen. Keep the live local object pending until that PUT succeeds.
                        materials.forEach(material => {
                            if (isRecording(material) && material.recordingCloudCommitted === true) {
                                material.recordingMetadataCloudCommitted = true;
                            } else if (!isRecording(material) && material.assetCloudCommitted === true) {
                                material.assetMetadataCloudCommitted = true;
                            }
                        });
                        notes.forEach(note => {
                            if (note && note.contentKey && note.contentCloudCommitted === true) {
                                note.contentMetadataCloudCommitted = true;
                            }
                        });
                    }
                    session.sourceFolder = materials;
                    session.notes = notes.map(note => {
                        if (note && note.contentKey) delete note.content;
                        return note;
                    });
                });
            });
        });
        return copy;
    }

    function timestamp(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    function baselineTime(value) {
        const baseline = Number(value);
        return Number.isFinite(baseline) ? baseline : 0;
    }

    function mergeClassroomMaterials(cloudMaterials, localMaterials, baseline) {
        const cloud = Array.isArray(cloudMaterials) ? cloudMaterials : [];
        const local = Array.isArray(localMaterials) ? localMaterials : [];
        const cutoff = baselineTime(baseline);
        const localById = new Map();
        local.forEach(material => {
            if (material && material.id) localById.set(material.id, material);
        });

        const cloudIds = new Set();
        const merged = cloud.map(cloudMaterial => {
            if (!cloudMaterial || !cloudMaterial.id) return deepClone(cloudMaterial);
            cloudIds.add(cloudMaterial.id);
            const localMaterial = localById.get(cloudMaterial.id);
            if (localMaterial && isMaterialCloudPending(localMaterial)) {
                return deepClone(Object.assign({}, cloudMaterial, localMaterial));
            }
            return deepClone(cloudMaterial);
        });

        local.forEach(material => {
            if (!material || !material.id || cloudIds.has(material.id)) return;
            const uploadedAt = timestamp(material.uploadedAt);
            if (isMaterialCloudPending(material) ||
                (Number.isFinite(uploadedAt) && uploadedAt > cutoff)) {
                merged.push(deepClone(material));
            }
        });
        return merged;
    }

    function mergeClassroomNotes(cloudNotes, localNotes, baseline) {
        const cloud = Array.isArray(cloudNotes) ? cloudNotes : [];
        const local = Array.isArray(localNotes) ? localNotes : [];
        const cutoff = baselineTime(baseline);
        const localById = new Map();
        local.forEach(note => {
            if (note && note.id) localById.set(note.id, note);
        });

        const cloudIds = new Set();
        const merged = cloud.map(cloudNote => {
            if (!cloudNote || !cloudNote.id) return deepClone(cloudNote);
            cloudIds.add(cloudNote.id);
            const localNote = localById.get(cloudNote.id);
            if (!localNote) return deepClone(cloudNote);
            const base = isNoteContentCloudPending(localNote)
                ? Object.assign({}, cloudNote, localNote)
                : Object.assign({}, cloudNote);
            base.progress = Math.max(Number(cloudNote.progress) || 0, Number(localNote.progress) || 0);
            base.maxProgress = Math.max(Number(cloudNote.maxProgress) || 0, Number(localNote.maxProgress) || 0);
            return deepClone(base);
        });

        local.forEach(note => {
            if (!note || !note.id || cloudIds.has(note.id)) return;
            const generatedAt = timestamp(note.generatedAt);
            if (isNoteContentCloudPending(note) ||
                (Number.isFinite(generatedAt) && generatedAt > cutoff)) {
                merged.push(deepClone(note));
            }
        });
        return merged;
    }

    return {
        NOTE_FORMAT,
        NOTE_CONTENT_PREFIX,
        noteContentKey,
        stripClassroomData,
        mergeClassroomMaterials,
        mergeClassroomNotes,
        isMaterialCloudPending,
        isNoteContentCloudPending
    };
});
