import { posix } from 'path'

import { Readable, pipelinePromise } from 'streamx'
import Hyperdrive from 'hyperdrive'
import { makeRoutedFetch } from 'make-fetch'
import mime from 'mime/lite.js'
import parseRange from 'range-parser'
import { EventIterator } from 'event-iterator'

const DEFAULT_TIMEOUT = 5000

const SPECIAL_DOMAIN = 'localhost'
const SPECIAL_FOLDER = '$'
const EXTENSIONS_FOLDER_NAME = 'extensions'
const EXTENSION_EVENT = 'extension-message'
const PEER_OPEN = 'peer-open'
const PEER_REMOVE = 'peer-remove'

const MIME_TEXT_PLAIN = 'text/plain; charset=utf-8'
const MIME_APPLICATION_JSON = 'application/json'
const MIME_TEXT_HTML = 'text/html; charset=utf-8'
const MIME_EVENT_STREAM = 'text/event-stream; charset=utf-8'

const HEADER_CONTENT_TYPE = 'Content-Type'

async function DEFAULT_RENDER_INDEX (url, files, fetch) {
  return `
<!DOCTYPE html>
<title>Index of ${url.pathname}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<h1>Index of ${url.pathname}</h1>
<ul>
  <li><a href="../">../</a></li>
  ${files.map((file) => `<li><a href="${file}">./${file}</a></li>`).join('\n')}
</ul>
`
}

export default async function makeHyperFetch ({
  sdk,
  writable = false,
  extensionMessages = writable,
  timeout = DEFAULT_TIMEOUT,
  renderIndex = DEFAULT_RENDER_INDEX
}) {
  const { fetch, router } = makeRoutedFetch()

  // Map loaded drive hostnames to their keys
  // TODO: Track LRU + cache clearing
  const drives = new Map()

  async function getDBCoreForName (name) {
    const corestore = sdk.namespace(name)
    const dbCore = corestore.get({ name: 'db' })
    await dbCore.ready()

    if (!dbCore.discovery) {
      const discovery = sdk.join(dbCore.discoveryKey)
      dbCore.discovery = discovery
      dbCore.once('close', () => {
        discovery.destroy()
      })
      await discovery.flushed()
    }

    return dbCore
  }

  async function getDrive (hostname) {
    if (drives.has(hostname)) {
      return drives.get(hostname)
    }

    const core = await sdk.get(hostname)

    const corestore = sdk.namespace(core.id)
    const drive = new Hyperdrive(corestore, core.key)

    await drive.ready()

    drives.set(drive.core.id, drive)
    drives.set(hostname, drive)

    return drive
  }

  async function getDriveFromKey (key, errorOnNew = false) {
    if (drives.has(key)) {
      return drives.get(key)
    }
    const core = await getDBCoreForName(key)
    if (!core.length && errorOnNew) {
      return { status: 400, body: 'Must create key with POST before reading' }
    }

    const corestore = sdk.namespace(key)
    const drive = new Hyperdrive(corestore)

    await drive.ready()

    drives.set(key, drive)
    drives.set(drive.core.id, drive)

    return drive
  }

  function getExtension (core, name) {
    const existing = core.extensions.get(name)
    if (existing) return existing
    console.log('Initializing extension', name, core.url)

    const extension = core.registerExtension(name, {
      encoding: 'utf8',
      onmessage: (content, peer) => {
        core.emit(EXTENSION_EVENT, name, content, peer)
      }
    })

    // console.log('Got extension', extension, core.extensions)

    return extension
  }

  function getExtensionPeers (core, name) {
    // List peers with this extension
    const allPeers = core.peers
    return allPeers.filter((peer) => {
      const { remoteExtensions } = peer

      if (!remoteExtensions) return false

      const { names } = remoteExtensions

      if (!names) return false

      return names.includes(name)
    })
  }

  function listExtensionNames (core) {
    // console.log(core.extensions, core.url)
    return [...core.extensions.keys()]
  }

  if (extensionMessages) {
    router.get(`hyper://*/${SPECIAL_FOLDER}/${EXTENSIONS_FOLDER_NAME}/`, async function listExtensions (request) {
      const { hostname } = new URL(request.url)
      const accept = request.headers.get('Accept') || ''

      const core = await sdk.get(`hyper://${hostname}/`)

      if (accept.includes('text/event-stream')) {
        const events = new EventIterator(({ push }) => {
          function onMessage (name, content, peer) {
            const id = peer.remotePublicKey.toString('hex')
            // TODO: Fancy verification on the `name`?
            // Send each line of content separately on a `data` line
            const data = content.split('\n').map((line) => `data:${line}\n`).join('')
            push(`id:${id}\nevent:${name}\n${data}\n`)
          }
          function onPeerOpen (peer) {
            const id = peer.remotePublicKey.toString('hex')
            push(`id:${id}\nevent:${PEER_OPEN}\n\n`)
          }
          function onPeerRemove (peer) {
            // Whatever, probably an uninitialized peer
            if (!peer.remotePublicKey) return
            const id = peer.remotePublicKey.toString('hex')
            push(`id:${id}\nevent:${PEER_REMOVE}\n\n`)
          }
          core.on(EXTENSION_EVENT, onMessage)
          core.on(PEER_OPEN, onPeerOpen)
          core.on(PEER_REMOVE, onPeerRemove)
          return () => {
            core.removeListener(EXTENSION_EVENT, onMessage)
            core.removeListener(PEER_OPEN, onPeerOpen)
            core.removeListener(PEER_REMOVE, onPeerRemove)
          }
        })

        return {
          statusCode: 200,
          headers: {
            [HEADER_CONTENT_TYPE]: MIME_EVENT_STREAM
          },
          body: events
        }
      }

      const extensions = listExtensionNames(core)
      return {
        status: 200,
        headers: { [HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON },
        body: JSON.stringify(extensions, null, '\t')
      }
    })
    router.get(`hyper://*/${SPECIAL_FOLDER}/${EXTENSIONS_FOLDER_NAME}/*`, async function listenExtension (request) {
      const { hostname, pathname } = new URL(request.url)
      const name = pathname.slice(`/${SPECIAL_FOLDER}/${EXTENSIONS_FOLDER_NAME}/`.length)

      const core = await sdk.get(`hyper://${hostname}/`)

      await getExtension(core, name)

      const peers = getExtensionPeers(core, name)
      const finalPeers = formatPeers(peers)
      const body = JSON.stringify(finalPeers, null, '\t')

      return {
        status: 200,
        body,
        headers: {
          [HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON
        }
      }
    })
    router.post(`hyper://*/${SPECIAL_FOLDER}/${EXTENSIONS_FOLDER_NAME}/*`, async function broadcastExtension (request) {
      const { hostname, pathname } = new URL(request.url)
      const name = pathname.slice(`/${SPECIAL_FOLDER}/${EXTENSIONS_FOLDER_NAME}/`.length)

      const core = await sdk.get(`hyper://${hostname}/`)

      const extension = await getExtension(core, name)
      const data = await request.arrayBuffer()
      extension.broadcast(data)

      return { status: 200 }
    })
    router.post(`hyper://*/${SPECIAL_FOLDER}/${EXTENSIONS_FOLDER_NAME}/*/*`, async function extensionToPeer (request) {
      const { hostname, pathname } = new URL(request.url)
      const subFolder = pathname.slice(`/${SPECIAL_FOLDER}/${EXTENSIONS_FOLDER_NAME}/`.length)
      const [name, extensionPeer] = subFolder.split('/')

      const core = await sdk.get(`hyper://${hostname}/`)

      const extension = await getExtension(core, name)
      const peers = getExtensionPeers(core, name)
      const peer = peers.find(({ remotePublicKey }) => remotePublicKey.toString('hex') === extensionPeer)
      if (!peer) {
        return {
          status: 404,
          headers: {
            [HEADER_CONTENT_TYPE]: MIME_TEXT_PLAIN
          },
          body: 'Peer Not Found'
        }
      }
      const data = await request.arrayBuffer()
      extension.send(data, peer)
      return { status: 200 }
    })
  }

  if (writable) {
    router.get(`hyper://${SPECIAL_DOMAIN}/`, async function getKey (request) {
      const key = new URL(request.url).searchParams.get('key')
      if (!key) {
        return { status: 400, body: 'Must specify key parameter to resolve' }
      }

      const drive = await getDriveFromKey(key, true)

      return { body: drive.url }
    })
    router.post(`hyper://${SPECIAL_DOMAIN}/`, async function createKey (request) {
      // TODO: Allow importing secret keys here
      // Maybe specify a seed to use for generating the blobs?
      // Else we'd need to specify the blobs keys and metadata keys

      const key = new URL(request.url).searchParams.get('key')
      if (!key) {
        return { status: 400, body: 'Must specify key parameter to resolve' }
      }

      const drive = await getDriveFromKey(key, false)

      return { body: drive.core.url }
    })

    router.put('hyper://*/**', async function putFiles (request) {
      const { hostname, pathname } = new URL(request.url)
      const contentType = request.headers.get('Content-Type') || ''
      const isFormData = contentType.includes('multipart/form-data')

      const drive = await getDrive(hostname)

      if (isFormData) {
        // It's a form! Get the files out and process them
        const formData = await request.formData()
        for (const [name, data] of formData) {
          if (name !== 'file') continue
          const filePath = posix.join(pathname, data.name)
          await pipelinePromise(
            Readable.from(data.stream()),
            drive.createWriteStream(filePath, {
              metadata: {
                mtime: Date.now()
              }
            })
          )
        }
      } else {
        await pipelinePromise(
          Readable.from(request.body),
          drive.createWriteStream(pathname)
        )
      }

      // TODO: Use 201 with location in response headers
      return { status: 200 }
    })
    router.delete('hyper://*/**', async function putFiles (request) {
      const { hostname, pathname } = new URL(request.url)

      const drive = await getDrive(hostname)

      if (pathname.endsWith('/')) {
        let didDelete = false
        for await (const entry of drive.list(pathname)) {
          await drive.del(entry.key)
          didDelete = true
        }
        if (!didDelete) {
          return { status: 404, body: 'Not Found', headers: { [HEADER_CONTENT_TYPE]: MIME_TEXT_PLAIN } }
        }
        return { status: 200 }
      }

      const entry = await drive.entry(pathname)

      if (!entry) {
        return { status: 404, body: 'Not Found', headers: { [HEADER_CONTENT_TYPE]: MIME_TEXT_PLAIN } }
      }
      await drive.del(pathname)

      return { status: 200 }
    })
  }

  router.head('hyper://*/**', async function headFiles (request) {
    const url = new URL(request.url)
    const { hostname, pathname, searchParams } = url
    const accept = request.headers.get('Accept') || ''
    const isRanged = request.headers.get('Range') || ''
    const noResolve = searchParams.has('noResolve')
    const isDirectory = pathname.endsWith('/')

    const resHeaders = {
      'Accept-Ranges': 'bytes'
    }

    const drive = await getDrive(hostname)

    if (isDirectory) {
      const entries = await listEntries(drive, pathname)

      const hasItems = entries.length

      if (!hasItems && pathname !== '/') {
        return {
          status: 404,
          headers: {
            [HEADER_CONTENT_TYPE]: MIME_TEXT_PLAIN
          }
        }
      }

      if (!noResolve) {
        if (entries.includes('index.html')) {
          return {
            status: 204,
            headers: {
              ...resHeaders,
              [HEADER_CONTENT_TYPE]: MIME_TEXT_HTML
            }
          }
        }
      }

      // TODO: Add range header calculation
      if (accept.includes('text/html')) {
        return {
          status: 204,
          headers: {
            ...resHeaders,
            [HEADER_CONTENT_TYPE]: MIME_TEXT_HTML
          }
        }
      }

      return {
        status: 204,
        headers: {
          ...resHeaders,
          [HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON
        }
      }
    }
    const entry = await drive.entry(pathname)

    if (!entry) {
      return { status: 404, body: 'Not Found' }
    }

    resHeaders.ETag = `${entry.seq}`

    const contentType = getMimeType(pathname)
    resHeaders['Content-Type'] = contentType

    if (entry.metadata?.mtime) {
      const date = new Date(entry.metadata.mtime)
      resHeaders['Last-Modified'] = date.toUTCString()
    }

    const size = entry.value.byteLength
    if (isRanged) {
      const ranges = parseRange(size, isRanged)

      if (ranges && ranges.length && ranges.type === 'bytes') {
        const [{ start, end }] = ranges
        const length = (end - start + 1)

        return {
          status: 200,
          headers: {
            ...resHeaders,
            'Content-Length': `${length}`,
            'Content-Range': `bytes ${start}-${end}/${size}`
          }
        }
      }
    }

    return {
      status: 200,
      headers: resHeaders
    }
  })

  // TODO: Redirect on directories without trailing slash
  router.get('hyper://*/**', async function getFiles (request) {
    const url = new URL(request.url)
    const { hostname, pathname, searchParams } = url
    const accept = request.headers.get('Accept') || ''
    const noResolve = searchParams.has('noResolve')
    const isDirectory = pathname.endsWith('/')

    const drive = await getDrive(hostname)

    if (isDirectory) {
      const entries = await listEntries(drive, pathname)

      if (!entries.length && pathname !== '/') {
        return {
          status: 404,
          body: '[]',
          headers: { [HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON }
        }
      }

      if (!noResolve) {
        if (entries.includes('index.html')) {
          return serveFile(request.headers, drive, posix.join(pathname, 'index.html'))
        }
      }

      if (accept.includes('text/html')) {
        const body = renderIndex(url, entries, fetch)
        return {
          status: 200,
          body,
          headers: { [HEADER_CONTENT_TYPE]: MIME_TEXT_HTML }
        }
      }

      return {
        status: 200,
        body: JSON.stringify(entries, null, '\t'),
        headers: { [HEADER_CONTENT_TYPE]: MIME_APPLICATION_JSON }
      }
    }
    const entry = await drive.entry(pathname)

    if (!entry) {
      return { status: 404, body: 'Not Found' }
    }

    return serveFile(request.headers, drive, pathname)
  })

  return fetch
}

async function serveFile (headers, drive, pathname) {
  const isRanged = headers.get('Range') || ''
  const contentType = getMimeType(pathname)

  const entry = await drive.entry(pathname)

  const resHeaders = {
    ETag: `${entry.seq}`,
    [HEADER_CONTENT_TYPE]: contentType,
    'Accept-Ranges': 'bytes'
  }

  if (entry.metadata?.mtime) {
    const date = new Date(entry.metadata.mtime)
    resHeaders['Last-Modified'] = date.toUTCString()
  }

  const size = entry.value.blob.byteLength
  if (isRanged) {
    const ranges = parseRange(size, isRanged)

    if (ranges && ranges.length && ranges.type === 'bytes') {
      const [{ start, end }] = ranges
      const length = (end - start + 1)

      return {
        status: 200,
        body: drive.createReadStream(pathname, {
          start,
          end
        }),
        headers: {
          ...resHeaders,
          'Content-Length': `${length}`,
          'Content-Range': `bytes ${start}-${end}/${size}`
        }
      }
    }
  }
  return {
    status: 200,
    headers: {
      ...resHeaders,
      'Content-Length': `${size}`
    },
    body: drive.createReadStream(pathname)
  }
}

async function listEntries (drive, pathname = '/') {
  const entries = []
  for await (const path of drive.readdir(pathname)) {
    const stat = await drive.entry(path)
    if (stat === null) {
      entries.push(path + '/')
    } else {
      entries.push(path)
    }
  }
  return entries
}

function formatPeers (peers) {
  return peers.map(({ remotePublicKey, remoteAddress, remoteType, stats }) => {
    return {
      remotePublicKey: remotePublicKey.toString('hex'),
      remoteType,
      remoteAddress,
      stats
    }
  })
}

function getMimeType (path) {
  let mimeType = mime.getType(path) || 'text/plain; charset=utf-8'
  if (mimeType.startsWith('text/')) mimeType = `${mimeType}; charset=utf-8`
  return mimeType
}
