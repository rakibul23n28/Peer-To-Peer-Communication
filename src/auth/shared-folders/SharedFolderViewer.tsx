import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import {
  buildSharedFolderTree,
  sortSharedFolderNodes,
  type SharedFolderManifest,
  type SharedFolderTreeNode,
} from "../../shared/sharedFolders"
import { OrbitIcon } from "../components/OrbitIcon"
import type { OrbitIconName } from "../components/OrbitIcon"

const rowHeight = 42
const overscan = 8

interface TreeRow {
  node: SharedFolderTreeNode
  level: number
  parentPath: string
  position: number
  setSize: number
  hasChildren: boolean
}

interface SharedFolderViewerProps {
  manifest: SharedFolderManifest
  invalidCount: number
  onClose: () => void
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function childrenOf(node: SharedFolderTreeNode): SharedFolderTreeNode[] {
  return sortSharedFolderNodes([...node.children.values()])
}

function fileIcon(name: string): OrbitIconName {
  const extension = name.split(".").pop()?.toLocaleLowerCase() ?? ""
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp"].includes(extension)) return "image"
  if (["mp4", "mov", "mkv", "webm", "avi"].includes(extension)) return "video"
  if (["mp3", "wav", "aac", "flac", "ogg", "m4a"].includes(extension)) return "audio"
  if (["zip", "7z", "rar", "tar", "gz"].includes(extension)) return "archive"
  if (["js", "ts", "tsx", "jsx", "html", "css", "json", "py", "go", "rs", "java"].includes(extension)) return "code"
  return "file"
}

function flattenTree(
  root: SharedFolderTreeNode,
  expanded: Set<string>,
  filter: string,
): TreeRow[] {
  const query = filter.trim().toLocaleLowerCase()
  const matchingPaths = new Set<string>()
  if (query) {
    const findMatches = (node: SharedFolderTreeNode): boolean => {
      let found = node.name.toLocaleLowerCase().includes(query)
      for (const child of node.children.values()) {
        if (findMatches(child)) {
          found = true
          if (child.path) matchingPaths.add(child.path)
        }
      }
      if (found && node.path) matchingPaths.add(node.path)
      return found
    }
    findMatches(root)
  }
  const rows: TreeRow[] = []
  const visit = (parent: SharedFolderTreeNode, level: number) => {
    const siblings = childrenOf(parent)
    for (const [index, node] of siblings.entries()) {
      const hasChildren = node.kind === "d" && node.children.size > 0
      if (query && !matchingPaths.has(node.path)) continue
      rows.push({
        node,
        level,
        parentPath: parent.path,
        position: index + 1,
        setSize: siblings.length,
        hasChildren,
      })
      const autoExpanded = query && hasChildren
      if (hasChildren && (expanded.has(node.path) || autoExpanded)) visit(node, level + 1)
    }
  }
  visit(root, 1)
  return rows
}

export function SharedFolderViewer({ manifest, invalidCount, onClose }: SharedFolderViewerProps) {
  const root = useMemo(() => buildSharedFolderTree(manifest.entries), [manifest])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]))
  const [filter, setFilter] = useState("")
  const [scrollTop, setScrollTop] = useState(0)
  const height = 460
  const [activeIndex, setActiveIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(() => flattenTree(root, expanded, filter), [expanded, filter, root])
  const visibleStart = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visibleEnd = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan)
  const visibleRows = rows.slice(visibleStart, visibleEnd)
  const files = manifest.entries.filter(({ k }) => k === "f")
  const totalSize = files.reduce((total, entry) => total + (entry.s ?? 0), 0)
  const folders = manifest.entries.filter(({ k }) => k === "d").length
  const expandedAll = () => {
    const paths = new Set<string>()
    const visit = (node: SharedFolderTreeNode) => {
      if (node.path && node.kind === "d" && node.children.size) paths.add(node.path)
      for (const child of node.children.values()) visit(child)
    }
    visit(root)
    setExpanded(paths)
  }

  useEffect(() => {
    if (activeIndex >= rows.length) setActiveIndex(Math.max(0, rows.length - 1))
  }, [activeIndex, rows.length])

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [onClose])

  function moveFocus(index: number) {
    if (!rows.length) return
    const next = Math.max(0, Math.min(rows.length - 1, index))
    setActiveIndex(next)
    const element = scrollRef.current
    if (element) {
      const top = next * rowHeight
      if (top < element.scrollTop) element.scrollTop = top
      else if (top + rowHeight > element.scrollTop + element.clientHeight) {
        element.scrollTop = top - element.clientHeight + rowHeight
      }
      window.requestAnimationFrame(() => element.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.focus())
    }
  }

  function handleTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const row = rows[activeIndex]
    if (!row) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveFocus(activeIndex + 1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      moveFocus(activeIndex - 1)
    } else if (event.key === "Home") {
      event.preventDefault()
      moveFocus(0)
    } else if (event.key === "End") {
      event.preventDefault()
      moveFocus(rows.length - 1)
    } else if (event.key === "ArrowRight" && row.hasChildren) {
      event.preventDefault()
      if (!expanded.has(row.node.path)) {
        setExpanded((current) => new Set(current).add(row.node.path))
      } else {
        moveFocus(activeIndex + 1)
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      if (row.hasChildren && expanded.has(row.node.path)) {
        setExpanded((current) => {
          const next = new Set(current)
          next.delete(row.node.path)
          return next
        })
      } else {
        const parentIndex = rows.findIndex(({ node }) => node.path === row.parentPath)
        if (parentIndex >= 0) moveFocus(parentIndex)
      }
    } else if ((event.key === "Enter" || event.key === " ") && row.hasChildren) {
      event.preventDefault()
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(row.node.path)) next.delete(row.node.path)
        else next.add(row.node.path)
        return next
      })
    }
  }

  return <div className="orbit-folder-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="orbit-folder-viewer" role="dialog" aria-modal="true" aria-labelledby="orbit-folder-viewer-title">
      <header className="orbit-folder-viewer-header">
        <div>
          <span className="eyebrow">SHARED FOLDER</span>
          <h2 id="orbit-folder-viewer-title">{manifest.rootName}</h2>
          <p>{files.length.toLocaleString()} files · {folders.toLocaleString()} folders · {formatSize(totalSize)}</p>
        </div>
        <button type="button" className="orbit-folder-close" aria-label="Close folder viewer" onClick={onClose}><OrbitIcon name="close" /></button>
      </header>
      {invalidCount > 0 && <p className="orbit-folder-invalid-note" role="status">
        {invalidCount.toLocaleString()} {invalidCount === 1 ? "item was" : "items were"} hidden because their names were invalid.
      </p>}
      <div className="orbit-folder-tree-controls">
        <label className="orbit-folder-search">
          <OrbitIcon name="search" size={16} />
          <input value={filter} onChange={(event) => { setFilter(event.target.value); setActiveIndex(0) }} placeholder="Filter by name" aria-label="Filter folder tree by name" />
        </label>
        <button type="button" onClick={expandedAll}>Expand all</button>
        <button type="button" onClick={() => setExpanded(new Set())}>Collapse all</button>
      </div>
      <div
        ref={scrollRef}
        className="orbit-folder-tree-scroll"
        role="tree"
        aria-label={`${manifest.rootName} contents`}
        tabIndex={-1}
        onKeyDown={handleTreeKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {rows.length === 0 && <p className="orbit-folder-no-results">{filter ? "No matching names." : "This folder is empty."}</p>}
        <div className="orbit-folder-tree-virtual" role="group" style={{ height: rows.length * rowHeight }}>
          {visibleRows.map((row, offset) => {
            const index = visibleStart + offset
            const isExpanded = expanded.has(row.node.path) || Boolean(filter && row.hasChildren)
            return <div
              id={`orbit-folder-row-${index}`}
              key={row.node.path}
              className="orbit-folder-tree-row"
              role="treeitem"
              aria-level={row.level}
              aria-expanded={row.hasChildren ? isExpanded : undefined}
              aria-setsize={row.setSize}
              aria-posinset={row.position}
              tabIndex={index === activeIndex ? 0 : -1}
              data-row-index={index}
              style={{ top: index * rowHeight, paddingLeft: `${12 + (row.level - 1) * 22}px` }}
              onFocus={() => setActiveIndex(index)}
              onClick={() => {
                setActiveIndex(index)
                if (row.hasChildren) {
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(row.node.path)) next.delete(row.node.path)
                    else next.add(row.node.path)
                    return next
                  })
                }
              }}
            >
              <span className="orbit-folder-tree-disclosure">{row.hasChildren ? <OrbitIcon name={isExpanded ? "expand" : "collapse"} size={14} /> : null}</span>
              <OrbitIcon name={row.node.kind === "d" ? "tree" : fileIcon(row.node.name)} size={16} />
              <span className="orbit-folder-tree-name">{row.node.name}</span>
              {row.node.kind === "f" && <span className="orbit-folder-tree-size">{formatSize(row.node.size ?? 0)}</span>}
              {row.node.kind === "d" && <span className="orbit-folder-tree-count">{row.node.children.size} items</span>}
            </div>
          })}
        </div>
      </div>
    </section>
  </div>
}
