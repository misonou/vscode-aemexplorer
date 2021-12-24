import { Uri } from "vscode";
import FormData from "form-data";
import mimetypes from "mime-types";
import { basename, fs, makeUri } from "../util";
import client from "./client";

type InitiateUploadResponse = { fileName: string }[] | {
    files: FileUploadInfo[];
    folderPath: string;
    completeURI: string;
};

interface FileUploadInfo {
    fileName: string;
    mimeType: string;
    uploadToken: string;
    uploadURIs: string[];
    minPartSize?: number;
    maxPartSize?: number;
}

interface CompleteUploadRequest {
    fileName: string;
    mimeType: string;
    uploadToken: string;
    createVersion?: boolean;
    versionLabel?: string;
    versionComment?: string;
    replace?: boolean;
}

export async function uploadAsset(jcrPath: Uri, filePath: Uri) {
    const filename = basename(filePath.path);
    const mimetype = mimetypes.contentType(filename) || '';
    const response: InitiateUploadResponse = await client.post(makeUri(jcrPath, `${jcrPath.path}.initiateUpload.json`), {
        path: jcrPath.path,
        mimeType: mimetype,
        fileName: filename,
        fileSize: (await fs.stat(filePath)).size
    });
    const buffer = Buffer.from(await fs.readFile(filePath));

    if (Array.isArray(response)) {
        let formData = new FormData();
        formData.append('fileName', response[0].fileName);
        formData.append('file', buffer, {
            filename: filename,
            contentType: mimetype
        });
        await client.post(makeUri(jcrPath, `${jcrPath.path}.createasset.html`), formData, {
            headers: { 'Sling-uploadmode': 'stream' }
        });
        return Uri.joinPath(jcrPath, response[0].fileName);
    } else {
        // upload asset to Adobe Experience Manager as Cloud Service
        let info = response.files[0];
        let chunks: Buffer[] = [];
        if (info.uploadURIs.length === 1) {
            chunks[0] = buffer;
        } else {
            for (let i = 0, j = 0, len = info.uploadURIs.length; i < len; i++, j += (info.maxPartSize || 0)) {
                chunks[i] = buffer.subarray(j, Math.min(info.maxPartSize || 0, buffer.length - j));
            }
        }
        await Promise.all(info.uploadURIs.map((v, i) => {
            return client.fetch(v, {
                method: 'PUT',
                body: chunks[i]
            });
        }));
        let completeUri = response.completeURI[0] === '/' ? makeUri(jcrPath, response.completeURI) : response.completeURI;
        let params: CompleteUploadRequest = {
            fileName: info.fileName,
            mimeType: info.mimeType,
            uploadToken: info.uploadToken
        };
        await client.post(completeUri, { ...params });
        return Uri.joinPath(jcrPath, info.fileName);
    }
}
