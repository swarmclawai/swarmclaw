import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { AgentWallet } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
  CREDENTIAL_SECRET: process.env.CREDENTIAL_SECRET,
}

let tempDir = ''
let encryptKey: typeof import('@/lib/server/storage').encryptKey
let callEthereumContract: typeof import('@/lib/server/ethereum').callEthereumContract
let encodeEthereumContractCall: typeof import('@/lib/server/ethereum').encodeEthereumContractCall
let prepareEvmSwapPlan: typeof import('@/lib/server/evm-swap').prepareEvmSwapPlan
let signEthereumMessage: typeof import('@/lib/server/ethereum').signEthereumMessage
let signEthereumTypedData: typeof import('@/lib/server/ethereum').signEthereumTypedData
let generateSolanaKeypair: typeof import('@/lib/server/solana').generateSolanaKeypair
let signSolanaMessage: typeof import('@/lib/server/solana').signSolanaMessage
let signSolanaTransaction: typeof import('@/lib/server/solana').signSolanaTransaction
let TransactionCtor: typeof import('@solana/web3.js').Transaction
let SystemProgramNs: typeof import('@solana/web3.js').SystemProgram
let PublicKeyCtor: typeof import('@solana/web3.js').PublicKey

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-wallet-exec-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  process.env.CREDENTIAL_SECRET = '11'.repeat(32)
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })

  ;({ encryptKey } = await import('@/lib/server/storage'))
  ;({ callEthereumContract, encodeEthereumContractCall, signEthereumMessage, signEthereumTypedData } = await import('@/lib/server/ethereum'))
  ;({ prepareEvmSwapPlan } = await import('@/lib/server/evm-swap'))
  ;({ generateSolanaKeypair, signSolanaMessage, signSolanaTransaction } = await import('@/lib/server/solana'))
  ;({ Transaction: TransactionCtor, SystemProgram: SystemProgramNs, PublicKey: PublicKeyCtor } = await import('@solana/web3.js'))
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  if (originalEnv.CREDENTIAL_SECRET === undefined) delete process.env.CREDENTIAL_SECRET
  else process.env.CREDENTIAL_SECRET = originalEnv.CREDENTIAL_SECRET
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('wallet execution helpers', () => {
  it('encodes ERC-20 contract calldata and signs EVM payloads', async () => {
    const privateKey = '0x59c6995e998f97a5a004497e5d4ab3d89165b0def05d6d33923995df83329538'
    const encrypted = encryptKey(privateKey)

    const encoded = encodeEthereumContractCall(
      ['function approve(address spender,uint256 amount)'],
      'approve',
      ['0x000000000000000000000000000000000000dEaD', '1000'],
    )
    assert.equal(encoded.data.startsWith('0x095ea7b3'), true)

    const encodedFromNamedArgs = encodeEthereumContractCall(
      ['function approve(address spender,uint256 amount)'],
      'approve',
      { spender: '0x000000000000000000000000000000000000dEaD', amount: '1000' },
    )
    assert.equal(encodedFromNamedArgs.data, encoded.data)

    const encodedTupleArg = encodeEthereumContractCall(
      ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)'],
      'quoteExactInputSingle',
      {
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000002',
        amountIn: '1000000',
        fee: 500,
        sqrtPriceLimitX96: '0',
      },
    )
    assert.equal(encodedTupleArg.data.startsWith('0xc6a5026a'), true)

    const signedMessage = await signEthereumMessage(encrypted, { message: 'hello world' })
    assert.equal(signedMessage.address.length, 42)
    assert.equal(signedMessage.signature.startsWith('0x'), true)

    const signedTypedData = await signEthereumTypedData(encrypted, {
      domain: {
        name: 'SwarmClaw',
        version: '1',
        chainId: 1,
      },
      types: {
        Login: [
          { name: 'wallet', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      value: {
        wallet: signedMessage.address,
        nonce: '7',
      },
    })
    assert.equal(signedTypedData.signature.startsWith('0x'), true)

    const called = await callEthereumContract(encrypted, {
      contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      abi: ['function name() view returns (string)'],
      functionName: 'name',
    }, {
      network: 'ethereum',
      rpcUrl: 'https://ethereum-rpc.publicnode.com',
    })
    assert.equal(called.decoded, 'Wrapped Ether')

    const allowance = await callEthereumContract(encrypted, {
      contractAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      abi: ['function allowance(address owner,address spender) view returns (uint256)'],
      functionName: 'allowance',
      args: {
        owner: signedMessage.address,
        spender: '0x000000000000000000000000000000000000dEaD',
      },
    }, {
      network: 'ethereum',
      rpcUrl: 'https://ethereum-rpc.publicnode.com',
    })
    assert.equal(typeof allowance.decoded, 'string')
  })

  it('builds a generic ParaSwap-backed swap plan for Arbitrum without a venue-specific adapter', async () => {
    const privateKey = '0x59c6995e998f97a5a004497e5d4ab3d89165b0def05d6d33923995df83329538'
    const encrypted = encryptKey(privateKey)
    const walletAddress = (await signEthereumMessage(encrypted, { message: 'derive address' })).address
    const wallet: AgentWallet = {
      id: 'wallet_swap_plan',
      agentId: 'agent_wallet',
      chain: 'ethereum',
      publicKey: walletAddress,
      encryptedPrivateKey: encrypted,
      spendingLimitAtomic: '1000000000000000000',
      dailyLimitAtomic: '10000000000000000000',
      requireApproval: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const plan = await prepareEvmSwapPlan({
      wallet,
      network: 'arbitrum',
      sellToken: 'USDC',
      buyToken: 'ETH',
      sellAmountDisplay: '1',
      skipBalanceCheck: true,
    })

    assert.equal(plan.provider, 'paraswap')
    assert.equal(plan.network.id, 'arbitrum')
    assert.equal(plan.sellToken.symbol, 'USDC')
    assert.equal(plan.buyToken.symbol, 'ETH')
    assert.equal(plan.sellAmountAtomic, '1000000')
    assert.equal(plan.approvalRequired, true)
    assert.equal(typeof plan.spenderAddress, 'string')
    assert.equal(typeof plan.swapTransaction.to, 'string')
    assert.equal(String(plan.swapTransaction.data || '').startsWith('0x'), true)
  })

  it('signs Solana messages and legacy transactions offline', async () => {
    const sender = generateSolanaKeypair()
    const recipient = generateSolanaKeypair()

    const signedMessage = await signSolanaMessage(sender.encryptedPrivateKey, { message: 'solana hello' })
    assert.equal(signedMessage.publicKey, sender.publicKey)
    assert.equal(signedMessage.signature.length > 40, true)

    const tx = new TransactionCtor()
    tx.feePayer = new PublicKeyCtor(sender.publicKey)
    tx.recentBlockhash = generateSolanaKeypair().publicKey
    tx.add(SystemProgramNs.transfer({
      fromPubkey: new PublicKeyCtor(sender.publicKey),
      toPubkey: new PublicKeyCtor(recipient.publicKey),
      lamports: 1_234,
    }))

    const unsignedBase64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64')
    const signedTx = await signSolanaTransaction(sender.encryptedPrivateKey, unsignedBase64)
    assert.equal(signedTx.publicKey, sender.publicKey)
    assert.equal(signedTx.signatures.length > 0, true)
    assert.equal(typeof signedTx.signedTransactionBase64, 'string')
  })
})
