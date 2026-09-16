import { useState } from 'react';
import RenameView from './RenameView';
import SplitView from './SplitView';
import { DOCUMENT_PROFILES, DEFAULT_PROFILE_ID, getProfile, describeProfile } from './lib/profiles';
import './App.css';

type Tab = 'split' | 'rename';

export default function App() {
  const [tab, setTab] = useState<Tab>('split');
  const [profileId, setProfileId] = useState<string>(DEFAULT_PROFILE_ID);
  // Whether the currently active tab has any rows loaded. Set by the view
  // itself via onHasRowsChange. Used to lock the document-type picker
  // while a batch is in progress -- switching profiles mid-batch used to
  // leave already-processed rows keyed to the old prefix/page-count while
  // newly edited or newly added rows picked up the new one, producing a
  // silently mixed-naming-convention export. Requiring "Clear" first
  // makes that mixing impossible rather than just unlikely.
  const [activeHasRows, setActiveHasRows] = useState(false);
  const profile = getProfile(profileId);

  return (
    <div className="app">
      <header className="header">
        <h1>PDF Splitter (PNL/EL Plan)</h1>
        <p className="subtitle">Split and rename batch PDF PNLs and EL Plans.</p>
        <p className="privacy">🔒 Files are processed locally in your browser and are not uploaded.</p>
      </header>

      <div className="profile-picker">
        <label htmlFor="profile-select">Document type:</label>
        <select
          id="profile-select"
          value={profileId}
          disabled={activeHasRows}
          onChange={(e) => setProfileId(e.target.value)}
          title={activeHasRows ? 'Clear the current batch to change document type' : undefined}
        >
          {DOCUMENT_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="profile-hint">{describeProfile(profile)}</span>
        {activeHasRows && <span className="profile-locked-hint">Clear the current batch to change document type</span>}
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'split' ? 'active' : ''}`} onClick={() => setTab('split')}>
          Split one merged PDF
        </button>
        <button className={`tab ${tab === 'rename' ? 'active' : ''}`} onClick={() => setTab('rename')}>
          Rename individual PDFs
        </button>
      </div>

      {tab === 'split' ? (
        <SplitView profile={profile} onHasRowsChange={setActiveHasRows} />
      ) : (
        <RenameView profile={profile} onHasRowsChange={setActiveHasRows} />
      )}
    </div>
  );
}
