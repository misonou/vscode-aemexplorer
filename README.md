# AEM Explorer

Integrates Adobe Experience Manager to Visual Studio Code for
more convenient development experience on AEM projects.

> **Warning**: This extension is meant for development purpose only.
  There is no warranty for any data loss caused by this extension,
  so run at your own risk on production environments.

## Features

### Repository Explorer

- Lists JCR nodes in tree view
- Contextual view
  - Resources grouped for each site: e.g.
    experience fragments, components, tags, assets, pages.
  - System resources:
    users, groups, packages, logs
- Functionalities
  - Quick open a resource in browser (AEM Touch UI)
  - Basic CRUD on repository
  - Content
    - Create pages
    - Create tags
    - Quick publish
  - Files
    - Preview and edit text files
    - Preview binary files
  - Authorizables
    - Create user and group
    - Update user membership and group members
  - Packages
    - Upload and install packages
    - Download packages
  - Open log stream

### Intellisense

- Completions and details on OSGi configuration attributes
- Completions on JCR content properties

### Workspace integration

- Export content to local AEM projects in workspace
- Open or reveal local file from repository explorer
- Open diff for local v.s. remote

## Settings

| Setting                         | Description                                                                            | Default Value               |
|---------------------------------|----------------------------------------------------------------------------------------|-----------------------------|
| `aemexplorer.hosts`             | List of URLs of Adobe Experience Manager authoring instances                           | `["http://localhost:4502"]` |
| `aemexplorer.syncPaths`         | Glob patterns relative to workspace which matched files are synchronized to AEM server | `[]`                        |
| `aemexplorer.deleteRemoteFiles` | Whether to delete files on server when synchronizing betweeen local and AEM server     | `false`                     |
