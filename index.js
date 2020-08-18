'use strict'

const yaml = require('js-yaml')
const fs = require('fs')
const exec = require('child_process').execSync
const axios = require('axios')
const bluebird = require('bluebird')

const getVersion = name => {
  let output
  try {
    output = exec(`pacman -Qi ${name}`)
  } catch {
    return null
  }
  const match = output.toString().match(/Version\s*\:\s*(.*)/)
  const firstGroup = match && match[1]
  // .replace(/^\d+\:/, '') just removes the number and colon from the beginning
  // (if any) e.g. 1:19.03.2-1 -> 19.03.2-1
  return firstGroup ? firstGroup.replace(/^\d+\:/, '') : null
}

const getRemoteVersion = async name => {
  // search by exact name
  const url = `https://www.archlinux.org/packages/search/json/?name=${name}`
  let response
  try {
    response = await axios.get(url)
  } catch {
    return null
  }
  const info = response.data && response.data.results[0]
  return !info ? null : `${info.pkgver}-${info.pkgrel}`
}

const getRemoteAurVersion = async name => {
  const url = `https://aur.archlinux.org/rpc/?v=5&type=search&arg=${name}`
  let response
  try {
    response = await axios.get(url)
  } catch {
    return null
  }
  const info = response.data && response.data.results[0]
  return !info ? null : info.Version
}

function flatten(input) {
  const stack = [...input]
  const res = []
  while (stack.length) {
    // pop value from stack
    const next = stack.pop()
    if (Array.isArray(next)) {
      // push back array items, won't modify the original input
      stack.push(...next)
    } else {
      res.push(next)
    }
  }
  //reverse to restore input order
  return res.reverse()
}

const packageList = yaml.safeLoad(fs.readFileSync('package-list.yml').toString())

const parsedPackageList = flatten(
  Object.entries(packageList).map(([group, packages]) => {
    return packages
      // normalize structure
      .map(current => {
        const entry = typeof current === 'string' ? { name: current, aur: false } : { ...current }
        return {
          ...entry,
          group,
          version: getVersion(entry.name),
        }
      })
      // only keep packages that are currently installed
      .filter(({ version }) => version)
  })
)

let sort_by

(function () {
  // utility functions
  var default_cmp = function (a, b) {
    if (a == b) return 0
    return a < b ? -1 : 1
  },
    getCmpFunc = function (primer, reverse) {
      var dfc = default_cmp, // closer in scope
        cmp = default_cmp
      if (primer) {
        cmp = function (a, b) {
          return dfc(primer(a), primer(b))
        }
      }
      if (reverse) {
        return function (a, b) {
          return -1 * cmp(a, b)
        }
      }
      return cmp
    }

  // actual implementation
  sort_by = function () {
    var fields = [],
      n_fields = arguments.length,
      field, name, reverse, cmp

    // preprocess sorting options
    for (var i = 0; i < n_fields; i++) {
      field = arguments[i]
      if (typeof field === 'string') {
        name = field
        cmp = default_cmp
      } else {
        name = field.name
        cmp = getCmpFunc(field.primer, field.reverse)
      }
      fields.push({
        name: name,
        cmp: cmp
      })
    }

    // final comparison function
    return function (A, B) {
      var a, b, name, result
      for (var i = 0; i < n_fields; i++) {
        result = 0
        field = fields[i]
        name = field.name

        result = field.cmp(A[name], B[name])
        if (result !== 0) break
      }
      return result
    }
  }
}())

const main = async () => {
  const result = await bluebird.map(
    parsedPackageList,
    async packageInfo => {
      console.log('Checking', packageInfo.name)
      return {
        ...packageInfo,
        remoteVersion: packageInfo.aur ?
          await getRemoteAurVersion(packageInfo.name) : await getRemoteVersion(packageInfo.name),
      }
    }, { concurrency: 10 },
  )
  const pendingUpdates = result
    .filter(packageInfo => packageInfo.remoteVersion && packageInfo.version !== packageInfo.remoteVersion)
    .sort(sort_by('group', 'aur', 'name'))
  console.table(pendingUpdates)
}

main().then()
