(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ExerciseUpload = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
    const PDF_HEADER_SCAN_BYTES = 1024;

    function toUint8Array(value) {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        return new Uint8Array(0);
    }

    function hasPdfHeader(value) {
        const bytes = toUint8Array(value);
        const limit = Math.min(bytes.length, PDF_HEADER_SCAN_BYTES);
        for (let offset = 0; offset <= limit - PDF_HEADER.length; offset++) {
            let matched = true;
            for (let index = 0; index < PDF_HEADER.length; index++) {
                if (bytes[offset + index] !== PDF_HEADER[index]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }

    function validQuestionStrings(value) {
        if (!Array.isArray(value)) return [];
        return value.filter(item => typeof item === 'string' && item.trim().length > 2);
    }

    return { hasPdfHeader, validQuestionStrings };
});
