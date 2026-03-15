'use client';
import { useEffect, useState, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { kb, getToken, type KBWithDocs } from '@/lib/api-client';

export default function KBDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [kbData, setKbData] = useState<KBWithDocs | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    kb.get(id).then(setKbData).catch(console.error);
  }, [id, router]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    for (const file of Array.from(files)) {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
      );
      await kb.uploadDocument(id, file.name, base64, file.type);
    }

    const updated = await kb.get(id);
    setKbData(updated);
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDeleteDoc = async (docId: string) => {
    await kb.deleteDocument(id, docId);
    const updated = await kb.get(id);
    setKbData(updated);
  };

  if (!kbData) return <div className="app-layout"><Sidebar /><main className="main-content"><p>Loading...</p></main></div>;

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1 className="page-title">{kbData.name}</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              Scope: {kbData.scope} | {kbData.documents.length} documents
            </p>
          </div>
          <div className="btn-group">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleUpload}
              style={{ display: 'none' }}
            />
            <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading...' : '+ Upload Document'}
            </button>
          </div>
        </div>

        <div className="card">
          {kbData.documents.length === 0 ? (
            <div className="empty-state">
              <h3>No documents</h3>
              <p>Upload documents to populate this knowledge base.</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Size</th>
                    <th>Type</th>
                    <th>Uploaded</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {kbData.documents.map((doc) => (
                    <tr key={doc.id}>
                      <td>{doc.filename}</td>
                      <td>{doc.file_size ? `${(doc.file_size / 1024).toFixed(1)} KB` : '-'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{doc.mime_type || '-'}</td>
                      <td>{new Date(doc.uploaded_at).toLocaleDateString()}</td>
                      <td>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDeleteDoc(doc.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
