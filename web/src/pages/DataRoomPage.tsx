import { useParams } from 'react-router-dom';
import DocumentDetail from './data-room/DocumentDetail';
import DocumentList from './data-room/DocumentList';

/** Route switch on `useParams().id`: the list view with no id, the detail view with one. All the
 * page's actual work lives in `pages/data-room/` — upload and the document table in
 * `DocumentList`, the version table and delete flow in `DocumentDetail`, one version row and its
 * chunk drill-in in `VersionRow`. */
export default function DataRoomPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <DocumentDetail id={id} /> : <DocumentList />;
}
