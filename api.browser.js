const insight = 'https://api.bitindex.network'
const bsv = require('bsv')
const BitDB = require('./bitdb.js')

/*
    Handling transfer
*/
async function transfer(address, key){
    var utxos = await getUTXOs(key.toAddress().toString())
    // 开始构造转账TX
    var tx = bsv.Transaction()
    utxos.forEach(utxo=>tx.from(utxo))
    tx.change(address)
    tx.feePerKb(1536)
    tx.sign(key)
    log(`转账TXID Transfer TXID: ${tx.id}`, logLevel.INFO)
    await broadcast_insight(tx.toString(), true)
}

/*
    Get UTXOs from insight API
*/
async function getUTXOs(address){
    return new Promise((resolve, reject)=>{
        fetch(insight + "/api/addrs/utxo", {
            method: 'POST',
            mode: 'cors',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `addrs=${address}`
        })
        .then(r=>r.json())
        .then(unspents=>{
            resolve(unspents)
        })
        .catch(err=>{
            reject("Insight API return Errors: " + err)
        })
    })
}

/*
    Broadcast transaction though insight API
*/
async function broadcast_insight(tx){
    return new Promise((resolve, reject)=>{
        fetch(insight + "/api/tx/send", {
            method: 'POST',
            mode: 'cors',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `rawtx=${tx.toString()}`
        })
        .then(r=>r.json())
        .then(body=>{
            if(body.errors){
                log(" Insight API return Errors: ", logLevel.INFO)
                log(err, logLevel.INFO)
                reject([tx.id,"Insight API return Errors: " + err.message.message])
            }else{
                resolve(body)
            }
        })
        .catch(err=>{
            log(" Insight API return Errors: ", logLevel.INFO)
            log(err, logLevel.INFO)
            reject([tx.id,"Insight API return Errors: " + err])
        })
    })
    
}

/*
    Wrapped broadcast transaction, push unbroadcast transaction into unbroadcast array provided.
*/
async function broadcast(tx, unBroadcast){
    try {
      const res = await broadcast_insight(tx)
      log(`Broadcasted ${res.txid}`, logLevel.INFO)
      return res
    } catch(e) {
      if(unBroadcast && Array.isArray(unBroadcast))unBroadcast.push(tx)
      throw e
    }
}

/*
    Try broadcast all transactions given.
    If TXs is null, load transactions from cache.
*/
async function tryBroadcastAll(TXs){
    var toBroadcast = TXs
    var unBroadcast = []
    for (let tx of toBroadcast) {
      try {
        await broadcast(tx, unBroadcast)
      } catch([txid,err]) {
        log(`${txid} 广播失败，原因 fail to broadcast:`, logLevel.INFO)
        log(err.split("\n")[0], logLevel.INFO)
        log(err.split("\n")[2], logLevel.INFO)
      }
    }
    return unBroadcast
}

/*
    Find exist bsvup B/Bcat record on blockchain.
    We use sha1 as file name.
*/
async function findExist(buf, mime) {
    var sha1 = bsv.crypto.Hash.sha1(buf).toString('hex')
    log(sha1, logLevel.VERBOSE)
    if (global.quick) return null
    var records = []
    if (!Array.isArray(records) || records.length == 0) {
        log(" - 向BitDB搜索已存在的文件记录 Querying BitDB", logLevel.VERBOSE)
        records = await BitDB.findExist(buf)
        records = records.filter(record => record.contenttype == mime)
    }
    if (records.length == 0) return null
    var txs = await Promise.all(records.map(record => getTX(record.txid)))
    var matchTX = await Promise.race(txs.map(tx => {
        return new Promise(async (resolve, reject) => {
            var databuf = await getData(tx).catch(err => new Buffer(0))
            if (databuf.equals(buf)) resolve(tx)
            else reject()
        })
    })).catch(err => null)
    if (matchTX){
        return matchTX
    }
    else {
        return null
    }
}

/*
    BitDB queries are expensive at time
    We should do a all in one query
*/
var dRecords = null
async function findD(key, address, value) {
    if (global.quick) return null
    //var dRecords = await BitDB.findD(key, address)
    if (!dRecords) {
        if(global.verbose) log(`查询${address}下所有D记录中...`, logLevel.INFO)
        if(global.verbose) log(`Query all D records on ${address} from BitDB...`, logLevel.INFO)
        dRecords = await BitDB.findD(null, address)
    }
    var keyDRecords = dRecords.filter(record => record.key == key)
    var dRecord = (keyDRecords.length > 0) ? keyDRecords[0] : null
    if (dRecord && dRecord.value == value) return true
    else return false
}

async function getTX(txid) {
    return new Promise((resolve, reject) => {
        var tx = null // Cache.loadTX(txid)
        if (tx) {
            resolve(tx)
        } else {
            fetch(insight + `/api/tx/${txid}`)
                .then(r=>r.json())
                .then(body=>{
                    if(body.errors){
                        reject(body.errors)
                    }else{
                        tx = bsv.Transaction(body.rawtx)
                        //Cache.saveTX(tx)
                        resolve(tx)
                    }
                })
                .catch(err=>{
                    log(`获取TX时发生错误 Error acquring TX ${txid}`, logLevel.INFO)
                    log(err, logLevel.INFO)
                    reject(err)
                })
        }
    }).catch(err => null)
}

/*
    Extract B/Bcat data from transaction(s)
*/
async function getData(tx) {
    var dataout = tx.outputs.filter(out => out.script.isDataOut())
    if (dataout.length == 0) throw new Error("Not Data TX")
    var bufs = dataout[0].script.chunks.map(chunk => (chunk.buf) ? chunk.buf : new bsv.deps.Buffer(0))
    if (bufs[1].toString() == "19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut") return bufs[2]
    else {
        // 处理Bcat
        var bParts = bufs.slice(7).map(buf => buf.toString('hex'))
        log("处理Bcat中。。。" + bParts, logLevel.VERBOSE)
        var bPartTXs = await Promise.all(bParts.map(bPart => getTX(bPart)))
        log(bPartTXs.map(tx => tx.id), logLevel.VERBOSE)
        var bPartBufs = bPartTXs.map(tx => tx.outputs.filter(out => out.script.isDataOut())[0].script.chunks[2].buf)
        log(bPartBufs.map(buf => buf.length), logLevel.VERBOSE)
        var buf = bsv.deps.Buffer.concat(bPartBufs)
        log(buf.length, logLevel.VERBOSE)
        return buf
    }
}

function readDir(file, dirHandle){
    return {}
}

function readFile(file, dirHandle) {
    return {}
}

function readFiles(path) {
    return []
}

function isDirectory(path){
    return false
}

const logLevel = {
    NONE: -1,
    CRITICAL: 0,
    ERROR: 1,
    WARNING: 2,
    INFO: 3,
    VERBOSE: 4
}

var currentLogLevel = logLevel.WARNING

function setLogLevel(level){
    currentLogLevel = level
}

function log(log, level){
    if(!(level > currentLogLevel)){
        log(log, logLevel.INFO)
    }
}

module.exports = {
    transfer: transfer,
    findD: findD,
    findExist: findExist,
    tryBroadcastAll: tryBroadcastAll,
    broadcast: broadcast,
    getUTXOs: getUTXOs,
    readFile: readFile,
    readDir: readDir,
    readFiles: readFiles,
    isDirectory: isDirectory,
    logLevel: logLevel,
    setLogLevel: setLogLevel,
    log: log
}