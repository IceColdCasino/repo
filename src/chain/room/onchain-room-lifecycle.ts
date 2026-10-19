import { createHash } from 'node:crypto';
import { Program, type AnchorProvider, web3, BN } from '@coral-xyz/anchor';
import {
  createMint,
  createAssociatedTokenAccount,
  createMintToInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { generateTableEncryptionKey, type TableEncryptionKey } from '../../bet-encryption';
export { WHITELIST_ADMIN } from '../../room-lifecycle';
import { ArciumPollingHelper } from '../../arcium/polling';
import { ArciumMPCHelper } from '../../arcium/mpc';
import { loadMxeAuthorityProvider, loadWhitelistAdminProvider } from '../admin-provider';
import { loadCasinoProgram } from '../../testing/deploy';
import { casinoVaultRemaining, sitOutInstruction } from '../rent-vault';

const CLOSE_SESSION = createHash('sha256').update('global:close_session').digest().subarray(0, 8);
const OPEN_ROOM_SESSION = createHash('sha256').update('global:open_room_session').digest().subarray(0, 8);
const OPEN_DELEGATED_ROOM_SESSION = createHash('sha256')
  .update('global:open_delegated_room_session')
  .digest()
  .subarray(0, 8);
const CLOSE_ROOM_SESSION = createHash('sha256').update('global:close_room_session').digest().subarray(0, 8);
const CLOSE_SESSION_ACCOUNTS = createHash('sha256')
  .update('global:close_session_accounts')
  .digest()
  .subarray(0, 8);
import { casinoOperatorMetas } from '../casino-factory';
import { confirmOrResend, installDurableConfirm } from '../confirm-tx';

export class OnchainRoomLifecycle {
  readonly polling: ArciumPollingHelper;
  private readonly arcium: ArciumMPCHelper;
  /** Sticky X25519 owner key per room_wallet — on-chain bind rejects rotation. */
  private readonly walletEncryptionKeys = new Map<string, TableEncryptionKey>();

  constructor(
    private pokerProgram: Program,
    private provider: AnchorProvider,
    public roomId: Uint8Array,
  ) {
    this.polling = new ArciumPollingHelper(provider);
    this.arcium = new ArciumMPCHelper(pokerProgram, provider);
    installDurableConfirm(provider.connection);
  }

  /** Reuse one encryption key for credit → buy-in → stake → settle on a wallet. */
  walletEncryptionKey(player: web3.PublicKey): TableEncryptionKey {
    const id = player.toBase58();
    let key = this.walletEncryptionKeys.get(id);
    if (!key) {
      key = generateTableEncryptionKey();
      this.walletEncryptionKeys.set(id, key);
    }
    return key;
  }

  /** Casino account plus the caller's admin PDA, when this room belongs to a tenant. */
  private casinoOperatorAccounts(
    adminProvider: AnchorProvider,
    casinoId?: Uint8Array,
  ): web3.AccountMeta[] {
    if (!casinoId) return [];
    return casinoOperatorMetas(casinoId, adminProvider.wallet.publicKey, this.pokerProgram.programId);
  }

  roomPDA(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('room'), Buffer.from(this.roomId)],
      this.pokerProgram.programId,
    )[0];
  }

  vaultPDA(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), Buffer.from(this.roomId)],
      this.pokerProgram.programId,
    )[0];
  }

  tablePDA(tableId: bigint): web3.PublicKey {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(tableId);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('table'), Buffer.from(this.roomId), idBuf],
      this.pokerProgram.programId,
    )[0];
  }

  roomWalletPDA(player: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('room_wallet'), player.toBuffer(), Buffer.from(this.roomId)],
      this.pokerProgram.programId,
    )[0];
  }

  pendingDepositPDA(player: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('pending_deposit'), player.toBuffer(), Buffer.from(this.roomId)],
      this.pokerProgram.programId,
    )[0];
  }

  tableEscrowPDA(player: web3.PublicKey, tableId: bigint): web3.PublicKey {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(tableId);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('table_escrow'), player.toBuffer(), Buffer.from(this.roomId), idBuf],
      this.pokerProgram.programId,
    )[0];
  }

  gameStatePDA(gameId: Uint8Array): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('game_state'), Buffer.from(gameId)],
      this.pokerProgram.programId,
    )[0];
  }

  roomSessionPDA(session: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('room_session'), Buffer.from(this.roomId), session.toBuffer()],
      this.pokerProgram.programId,
    )[0];
  }

  roomSessionLockPDA(owner: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('room_session_lock'), Buffer.from(this.roomId), owner.toBuffer()],
      this.pokerProgram.programId,
    )[0];
  }

  /** Owner pubkey stored on the session account. The player key when it is not open yet. */
  async sessionOwner(player: web3.PublicKey): Promise<web3.PublicKey> {
    const info = await this.provider.connection.getAccountInfo(this.roomSessionPDA(player));
    if (!info || info.data.length < 72) return player;
    return new web3.PublicKey(info.data.subarray(40, 72));
  }

  whitelistPDA(player: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('whitelist'), Buffer.from(this.roomId), player.toBuffer()],
      this.pokerProgram.programId,
    )[0];
  }

  dealerPoolPDA(tableId: bigint): web3.PublicKey {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(tableId);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('dealer_pool'), Buffer.from(this.roomId), idBuf],
      this.pokerProgram.programId,
    )[0];
  }

  protocolTreasuryPDA(): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('protocol_treasury'), Buffer.from(this.roomId)],
      this.pokerProgram.programId,
    )[0];
  }

  poolStakePDA(dealerPool: web3.PublicKey, staker: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('pool_stake'), dealerPool.toBuffer(), staker.toBuffer()],
      this.pokerProgram.programId,
    )[0];
  }

  async initDealerPool(
    tableId: bigint,
    gameKind: number,
    opts?: { minBet?: bigint; maxBet?: bigint; betUnit?: bigint },
  ): Promise<web3.PublicKey> {
    const dealerPool = this.dealerPoolPDA(tableId);
    const isRoulette = gameKind === 4;
    const isCasino = gameKind >= 1 && gameKind <= 4;
    const minBet = opts?.minBet ?? (isRoulette ? 10n : isCasino ? 100n : 0n);
    const maxBet = opts?.maxBet ?? (isRoulette ? 100n : isCasino ? 10_000n : 0n);
    const betUnit = opts?.betUnit ?? (isRoulette ? 0n : isCasino ? minBet : 0n);
    await (this.pokerProgram.methods as any)
      .initDealerPool(
        gameKind,
        new BN(minBet.toString()),
        new BN(maxBet.toString()),
        new BN(betUnit.toString()),
      )
      .accounts({
        payer: this.provider.wallet.publicKey,
        room: this.roomPDA(),
        tableState: this.tablePDA(tableId),
        dealerPool,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    return dealerPool;
  }

  async initProtocolTreasury(): Promise<web3.PublicKey> {
    const protocolTreasury = this.protocolTreasuryPDA();
    await (this.pokerProgram.methods as any)
      .initProtocolTreasury()
      .accounts({
        payer: this.provider.wallet.publicKey,
        room: this.roomPDA(),
        protocolTreasury,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    return protocolTreasury;
  }

  async initPoolStake(
    tableId: bigint,
    staker = this.provider.wallet.publicKey,
  ): Promise<web3.PublicKey> {
    const dealerPool = this.dealerPoolPDA(tableId);
    const poolStake = this.poolStakePDA(dealerPool, staker);
    await (this.pokerProgram.methods as any)
      .initPoolStake()
      .accounts({
        payer: this.provider.wallet.publicKey,
        dealerPool,
        poolStake,
        staker,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    return poolStake;
  }

  async stakeDealerPool(
    tableId: bigint,
    stakeAmount: bigint,
    computationOffset: number,
    staker: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<void> {
    const stakerKp = 'secretKey' in (staker as object) ? (staker as web3.Keypair) : null;
    const stakerPk = stakerKp?.publicKey ?? (staker as web3.PublicKey);
    const dealerPool = this.dealerPoolPDA(tableId);
    const poolStake = this.poolStakePDA(dealerPool, stakerPk);
    const tableKey = this.walletEncryptionKey(stakerPk);
    const offsetBn = new BN(computationOffset);
    await this.arcium.payComputationFromFloat(offsetBn, async () => {
      const builder = (this.pokerProgram.methods as any)
        .stakeDealerPool(
          offsetBn,
          new BN(stakeAmount.toString()),
          Array.from(tableKey.publicKey),
          new BN(tableKey.nonceBase.toString()),
        )
        .accountsPartial({
          payer: stakerPk,
          room: this.roomPDA(),
          whitelistEntry: this.whitelistPDA(stakerPk),
          dealerPool,
          roomWallet: this.roomWalletPDA(stakerPk),
          poolStake,
          ...this.arcium.arciumQueueAccounts(offsetBn, 'stakeDealerPool'),
        });
      if (stakerKp && !stakerKp.publicKey.equals(this.provider.wallet.publicKey)) {
        await builder.signers([stakerKp]).rpc();
      } else {
        await builder.rpc();
      }
    }, stakerKp);
    this.arcium.noteComputation(offsetBn);
  }

  async redeemDealerPool(
    tableId: bigint,
    redeemAmount: bigint,
    sharesToBurn: bigint,
    computationOffset: number,
    staker = this.provider.wallet.publicKey,
  ): Promise<void> {
    const dealerPool = this.dealerPoolPDA(tableId);
    const poolStake = this.poolStakePDA(dealerPool, staker);
    const tableKey = this.walletEncryptionKey(staker);
    await (this.pokerProgram.methods as any)
      .redeemDealerPool(
        computationOffset,
        redeemAmount,
        sharesToBurn,
        Array.from(tableKey.publicKey),
        tableKey.nonceBase,
      )
      .accounts({
        payer: staker,
        room: this.roomPDA(),
        whitelistEntry: this.whitelistPDA(staker),
        dealerPool,
        roomWallet: this.roomWalletPDA(staker),
        poolStake,
      })
      .rpc();
  }

  async applyCasinoPlayerNet(
    tableId: bigint,
    playerNetAbs: bigint,
    playerWon: boolean,
    computationOffset: number,
    player = this.provider.wallet.publicKey,
  ): Promise<void> {
    const tableKey = this.walletEncryptionKey(player);
    await (this.pokerProgram.methods as any)
      .applyCasinoPlayerNet(
        computationOffset,
        playerNetAbs,
        playerWon,
        Array.from(tableKey.publicKey),
        tableKey.nonceBase,
      )
      .accounts({
        payer: this.provider.wallet.publicKey,
        room: this.roomPDA(),
        tableState: this.tablePDA(tableId),
        whitelistEntry: this.whitelistPDA(player),
        player,
        tableEscrow: this.tableEscrowPDA(player, tableId),
      })
      .rpc();
  }

  async withdrawProtocolCommissions(
    amount: bigint,
    recipientTokenAccount: web3.PublicKey,
    adminProvider: AnchorProvider,
  ): Promise<void> {
    await (this.pokerProgram.methods as any)
      .withdrawProtocolCommissions(new BN(amount.toString()))
      .accounts({
        authority: adminProvider.wallet.publicKey,
        room: this.roomPDA(),
        protocolTreasury: this.protocolTreasuryPDA(),
        vault: this.vaultPDA(),
        recipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(adminProvider.wallet.payer ? [adminProvider.wallet.payer] : [])
      .rpc();
  }

  async addToWhitelist(
    player: web3.PublicKey,
    adminProvider: AnchorProvider,
    casinoId?: Uint8Array,
  ): Promise<web3.PublicKey> {
    const whitelistEntry = this.whitelistPDA(player);
    await (this.pokerProgram.methods as any)
      .addToWhitelist(Array.from(this.roomId))
      .accounts({
        admin: adminProvider.wallet.publicKey,
        room: this.roomPDA(),
        playerToWhitelist: player,
        whitelistEntry,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(this.casinoOperatorAccounts(adminProvider, casinoId))
      .signers(adminProvider.wallet.payer ? [adminProvider.wallet.payer] : [])
      .rpc();
    return whitelistEntry;
  }

  async removeFromWhitelist(
    player: web3.PublicKey,
    adminProvider: AnchorProvider,
    casinoId?: Uint8Array,
  ): Promise<void> {
    const remaining = casinoId
      ? [
          { pubkey: this.roomPDA(), isSigner: false, isWritable: false },
          ...this.casinoOperatorAccounts(adminProvider, casinoId),
        ]
      : [];
    await (this.pokerProgram.methods as any)
      .removeFromWhitelist()
      .accounts({
        admin: adminProvider.wallet.publicKey,
        whitelistEntry: this.whitelistPDA(player),
      })
      .remainingAccounts(remaining)
      .signers(adminProvider.wallet.payer ? [adminProvider.wallet.payer] : [])
      .rpc();
  }

  async createSplMint(): Promise<web3.PublicKey> {
    return createMint(
      this.provider.connection,
      this.provider.wallet.payer!,
      this.provider.wallet.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );
  }

  async createPlayerTokenAccount(mint: web3.PublicKey, owner: web3.PublicKey): Promise<web3.PublicKey> {
    return createAssociatedTokenAccount(
      this.provider.connection,
      this.provider.wallet.payer!,
      mint,
      owner,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  async mintTokens(mint: web3.PublicKey, dest: web3.PublicKey, amount: bigint): Promise<void> {
    const payer = this.provider.wallet.payer;
    if (!payer) throw new Error('mint requires a keypair wallet');
    await confirmOrResend(this.provider.connection, async (latest) => {
      const tx = new web3.Transaction({
        feePayer: payer.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(createMintToInstruction(
        mint,
        dest,
        this.provider.wallet.publicKey,
        amount,
        [],
        TOKEN_PROGRAM_ID,
      ));
      tx.sign(payer);
      return this.provider.connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: 'confirmed',
      });
    });
  }

  async createRoom(
    mint: web3.PublicKey,
    adminProvider: AnchorProvider,
    smallBlind = 10n,
    casinoId?: Uint8Array,
  ): Promise<{ room: web3.PublicKey; vault: web3.PublicKey }> {
    const room = this.roomPDA();
    const vault = this.vaultPDA();
    await (this.pokerProgram.methods as any)
      .createRoom(Array.from(this.roomId), new BN(smallBlind.toString()))
      .accounts({
        authority: adminProvider.wallet.publicKey,
        room,
        mint,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(this.casinoOperatorAccounts(adminProvider, casinoId))
      .signers(adminProvider.wallet.payer ? [adminProvider.wallet.payer] : [])
      .rpc();
    return { room, vault };
  }

  async createTable(
    adminProvider: AnchorProvider,
    gameKind = 0,
    shoeDecks = 1,
    rouletteVariant = 0,
    opts?: { minBet?: bigint; maxBet?: bigint; betUnit?: bigint; casinoId?: Uint8Array },
  ): Promise<{ tableId: bigint; tableState: web3.PublicKey }> {
    const room = this.roomPDA();
    const roomAccount = await (this.pokerProgram.account as any).room.fetch(room);
    const tableId = BigInt(roomAccount.tableCount.toString());
    const tableState = this.tablePDA(tableId);
    // GameKind: Poker=0 Baccarat=1 Blackjack=2 War=3 Roulette=4 Craps=5 Keno=6 Slots=7 Bingo=8
    const isHouseTable = gameKind === 4 || gameKind === 5 || gameKind === 6 || gameKind === 7;
    const isCasino = gameKind >= 1 && gameKind <= 8;
    const minBet = opts?.minBet ?? (isHouseTable ? 10n : isCasino ? 100n : 0n);
    // Keep house-game max modest so default dealer-pool stake covers liability.
    const maxBet = opts?.maxBet ?? (isHouseTable ? 100n : isCasino ? 10_000n : 0n);
    const betUnit =
      opts?.betUnit ?? (isHouseTable ? 0n : isCasino ? minBet : 0n);
    await (this.pokerProgram.methods as any)
      .createTable(
        gameKind,
        shoeDecks,
        rouletteVariant,
        new BN(minBet.toString()),
        new BN(maxBet.toString()),
        new BN(betUnit.toString()),
      )
      .accounts({
        authority: adminProvider.wallet.publicKey,
        room,
        tableState,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(this.casinoOperatorAccounts(adminProvider, opts?.casinoId))
      .signers(adminProvider.wallet.payer ? [adminProvider.wallet.payer] : [])
      .rpc();
    return { tableId, tableState };
  }

  async initRoomWallet(
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<web3.PublicKey> {
    const playerKp = typeof player === 'object' && 'secretKey' in player ? player : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const roomWallet = this.roomWalletPDA(playerPk);
    const builder = (this.pokerProgram.methods as any)
      .initRoomWallet(Array.from(this.roomId))
      .accounts({
        payer: this.provider.wallet.publicKey,
        room: this.roomPDA(),
        whitelistEntry: this.whitelistPDA(playerPk),
        roomWallet,
        player: playerPk,
        systemProgram: web3.SystemProgram.programId,
      });
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      await builder.signers([playerKp]).rpc();
    } else {
      await builder.rpc();
    }
    return roomWallet;
  }

  async depositSpl(
    amount: bigint,
    playerTokenAccount: web3.PublicKey,
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<void> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const builder = (this.pokerProgram.methods as any)
      .depositSpl(new BN(amount.toString()))
      .accounts({
        player: playerPk,
        room: this.roomPDA(),
        whitelistEntry: this.whitelistPDA(playerPk),
        vault: this.vaultPDA(),
        roomWallet: this.roomWalletPDA(playerPk),
        pendingDeposit: this.pendingDepositPDA(playerPk),
        playerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(casinoVaultRemaining(playerPk, this.pokerProgram.programId));
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      await builder.signers([playerKp]).rpc();
    } else {
      await builder.rpc();
    }
  }

  async requestCreditRoomBalance(
    depositAmount: bigint,
    offset: number,
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<void> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const tableKey = this.walletEncryptionKey(playerPk);
    const offsetBn = new BN(offset);
    // `RequestCreditRoomBalance.payer` seeds room_wallet / pending_deposit — must be the player.
    // The vault fronts the computation rent before this transaction. Passing it
    // again would make the in-handler reimburse draw that rent a second time.
    const builder = (this.pokerProgram.methods as any)
      .requestCreditRoomBalance(
        offsetBn,
        new BN(depositAmount.toString()),
        Array.from(tableKey.publicKey),
        new BN(tableKey.nonceBase.toString()),
      )
      .accountsPartial({
        payer: playerPk,
        room: this.roomPDA(),
        whitelistEntry: this.whitelistPDA(playerPk),
        roomWallet: this.roomWalletPDA(playerPk),
        pendingDeposit: this.pendingDepositPDA(playerPk),
        ...this.arcium.arciumQueueAccounts(offsetBn, 'creditRoomBalance'),
      });
    await this.arcium.payComputationFromFloat(offsetBn, async () => {
      if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
        await builder.signers([playerKp]).rpc();
      } else {
        await builder.rpc();
      }
    }, playerKp);
    this.arcium.noteComputation(offsetBn, playerKp, true);
  }

  /**
   * Open a room session for this player's own key. It stays valid until
   * `closeRoomSession`. A second call is a no-op.
   */
  async openRoomSession(player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey): Promise<void> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const existing = await this.provider.connection.getAccountInfo(this.roomSessionPDA(playerPk));
    if (existing) return;
    const ix = new web3.TransactionInstruction({
      programId: this.pokerProgram.programId,
      keys: [
        { pubkey: this.provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPk, isSigner: true, isWritable: false },
        { pubkey: this.roomPDA(), isSigner: false, isWritable: false },
        { pubkey: this.whitelistPDA(playerPk), isSigner: false, isWritable: false },
        { pubkey: this.roomSessionPDA(playerPk), isSigner: false, isWritable: true },
        { pubkey: this.roomSessionLockPDA(playerPk), isSigner: false, isWritable: true },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: OPEN_ROOM_SESSION,
    });
    const extra = playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey) ? [playerKp] : [];
    await this.sendSigned([ix], extra);
  }

  /**
   * Owner authorizes `session` for this room. The session key is whitelisted
   * and is the key that sits. The owner can sit at many tables, and only one
   * of their session keys can occupy a given table.
   */
  async openDelegatedRoomSession(owner: web3.Keypair, session: web3.Keypair): Promise<void> {
    const existing = await this.provider.connection.getAccountInfo(this.roomSessionPDA(session.publicKey));
    if (existing) return;
    const ix = new web3.TransactionInstruction({
      programId: this.pokerProgram.programId,
      keys: [
        { pubkey: this.provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: session.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.roomPDA(), isSigner: false, isWritable: false },
        { pubkey: this.whitelistPDA(owner.publicKey), isSigner: false, isWritable: false },
        { pubkey: this.whitelistPDA(session.publicKey), isSigner: false, isWritable: true },
        { pubkey: this.roomSessionPDA(session.publicKey), isSigner: false, isWritable: true },
        { pubkey: this.roomSessionLockPDA(owner.publicKey), isSigner: false, isWritable: true },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: OPEN_DELEGATED_ROOM_SESSION,
    });
    const extra = [owner, session].filter(
      (kp) => !kp.publicKey.equals(this.provider.wallet.publicKey),
    );
    await this.sendSigned([ix], extra);
  }

  /**
   * Reclaim a session that is not seated. `ownerKp` signs when the owner is
   * not the provider wallet. For a self-session the player key is the owner.
   */
  async closeRoomSession(
    session: web3.PublicKey | web3.Keypair,
    ownerKp?: web3.Keypair,
  ): Promise<void> {
    const sessionKp = 'secretKey' in (session as object) ? (session as web3.Keypair) : null;
    const sessionPk = sessionKp ? sessionKp.publicKey : (session as web3.PublicKey);
    const owner = ownerKp?.publicKey ?? await this.sessionOwner(sessionPk);
    const ix = new web3.TransactionInstruction({
      programId: this.pokerProgram.programId,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: this.roomSessionPDA(sessionPk), isSigner: false, isWritable: true },
      ],
      data: CLOSE_ROOM_SESSION,
    });
    const extra = [ownerKp, sessionKp].filter(
      (kp): kp is web3.Keypair => !!kp
        && kp.publicKey.equals(owner)
        && !kp.publicKey.equals(this.provider.wallet.publicKey),
    );
    await this.sendSigned([ix], extra.slice(0, 1));
  }

  async sitAtTable(
    tableId: bigint,
    physicalSeat: number,
    buyIn: bigint,
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<web3.PublicKey> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    await this.openRoomSession(player);
    const owner = await this.sessionOwner(playerPk);
    const tableState = this.tablePDA(tableId);
    const tableEscrow = this.tableEscrowPDA(playerPk, tableId);
    const builder = (this.pokerProgram.methods as any)
      .sitAtTable(physicalSeat, new BN(buyIn.toString()))
      .accounts({
        payer: this.provider.wallet.publicKey,
        player: playerPk,
        room: this.roomPDA(),
        whitelistEntry: this.whitelistPDA(playerPk),
        tableState,
        roomWallet: this.roomWalletPDA(playerPk),
        tableEscrow,
        roomSession: this.roomSessionPDA(playerPk),
        roomSessionLock: this.roomSessionLockPDA(owner),
        systemProgram: web3.SystemProgram.programId,
      });
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      await builder.signers([playerKp]).rpc();
    } else {
      await builder.rpc();
    }
    return tableEscrow;
  }

  async lockTableBuyin(
    tableId: bigint,
    buyIn: bigint,
    offset: number,
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<void> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const tableKey = this.walletEncryptionKey(playerPk);
    const offsetBn = new BN(offset);
    const builder = (this.pokerProgram.methods as any)
      .lockTableBuyin(
        new BN(buyIn.toString()),
        offsetBn,
        Array.from(tableKey.publicKey),
        new BN(tableKey.nonceBase.toString()),
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        player: playerPk,
        whitelistEntry: this.whitelistPDA(playerPk),
        roomWallet: this.roomWalletPDA(playerPk),
        tableEscrow: this.tableEscrowPDA(playerPk, tableId),
        ...this.arcium.arciumQueueAccounts(offsetBn, 'lockTableBuyin'),
      });
    await this.arcium.payComputationFromFloat(offsetBn, async () => {
      if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
        await builder.signers([playerKp]).rpc();
      } else {
        await builder.rpc();
      }
    });
    this.arcium.noteComputation(offsetBn);
  }

  async faucetCreditPersonal(
    player: web3.PublicKey | web3.Keypair,
    amount: bigint,
  ): Promise<void> {
    const playerKp = typeof player === 'object' && 'secretKey' in player ? player : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const builder = (this.pokerProgram.methods as any)
      .faucetCreditPersonal(new BN(amount.toString()))
      .accounts({
        payer: this.provider.wallet.publicKey,
        player: playerPk,
        room: this.roomPDA(),
        whitelistEntry: this.whitelistPDA(playerPk),
        roomWallet: this.roomWalletPDA(playerPk),
      });
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      await builder.signers([playerKp]).rpc();
    } else {
      await builder.rpc();
    }
  }

  async transferPersonalToSeat(
    tableId: bigint,
    amount: bigint,
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<void> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const builder = (this.pokerProgram.methods as any)
      .transferPersonalToSeat(new BN(amount.toString()))
      .accounts({
        player: playerPk,
        whitelistEntry: this.whitelistPDA(playerPk),
        tableState: this.tablePDA(tableId),
        roomWallet: this.roomWalletPDA(playerPk),
        tableEscrow: this.tableEscrowPDA(playerPk, tableId),
      });
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      await builder.signers([playerKp]).rpc();
    } else {
      await builder.rpc();
    }
  }

  async transferSeatToPersonal(
    tableId: bigint,
    amount: bigint,
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<void> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const builder = (this.pokerProgram.methods as any)
      .transferSeatToPersonal(new BN(amount.toString()))
      .accounts({
        player: playerPk,
        whitelistEntry: this.whitelistPDA(playerPk),
        tableState: this.tablePDA(tableId),
        roomWallet: this.roomWalletPDA(playerPk),
        tableEscrow: this.tableEscrowPDA(playerPk, tableId),
      });
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      await builder.signers([playerKp]).rpc();
    } else {
      await builder.rpc();
    }
  }

  async startHand(
    tableId: bigint,
    gameId: Uint8Array,
    player: web3.Keypair,
  ): Promise<web3.PublicKey> {
    const gameState = this.gameStatePDA(gameId);
    const signers = player.publicKey.equals(this.provider.wallet.publicKey) ? [] : [player];
    await (this.pokerProgram.methods as any)
      .startHand(Array.from(gameId))
      .accounts({
        authority: player.publicKey,
        room: this.roomPDA(),
        whitelistEntry: this.whitelistPDA(player.publicKey),
        tableState: this.tablePDA(tableId),
        dealerPool: this.dealerPoolPDA(tableId),
        gameState,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers(signers)
      .rpc();
    return gameState;
  }

  async markInHand(
    tableId: bigint,
    player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey,
  ): Promise<void> {
    const playerKp = player instanceof web3.Keypair ? player : null;
    const playerPk = playerKp ? playerKp.publicKey : player;
    const builder = (this.pokerProgram.methods as any)
      .markInHand()
      .accounts({
        player: playerPk,
        whitelistEntry: this.whitelistPDA(playerPk),
        tableState: this.tablePDA(tableId),
        roomWallet: this.roomWalletPDA(playerPk),
      });
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      await builder.signers([playerKp]).rpc();
    } else {
      await builder.rpc();
    }
  }

  async endHand(
    tableId: bigint,
    authorityProvider: AnchorProvider = this.provider,
  ): Promise<void> {
    await (this.pokerProgram.methods as any)
      .endHand()
      .accounts({
        authority: authorityProvider.wallet.publicKey,
        room: this.roomPDA(),
        tableState: this.tablePDA(tableId),
      })
      .signers(authorityProvider.wallet.payer ? [authorityProvider.wallet.payer] : [])
      .rpc();
  }

  /** Mint pubkey stored on the room account. */
  async roomMint(): Promise<web3.PublicKey> {
    const info = await this.provider.connection.getAccountInfo(this.roomPDA(), 'confirmed');
    if (!info || info.data.length < 104) throw new Error('room account is missing');
    return new web3.PublicKey(info.data.subarray(72, 104));
  }

  /**
   * Burn each seat's chips, close those token accounts, and close the mint
   * once nothing remains. Rent lands on `rentDest`.
   */
  async reclaimChips(
    mint: web3.PublicKey,
    players: web3.Keypair[],
    rentDest: web3.PublicKey,
  ): Promise<number> {
    const ixs: web3.TransactionInstruction[] = [];
    const signers: web3.Keypair[] = [];
    let returned = 0;
    let ataSupply = 0n;
    for (const player of players) {
      const ata = getAssociatedTokenAddressSync(mint, player.publicKey);
      const info = await this.provider.connection.getAccountInfo(ata, 'confirmed');
      if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) continue;
      let amount = 0n;
      try {
        amount = (await getAccount(this.provider.connection, ata, 'confirmed')).amount;
      } catch {
        continue;
      }
      returned += info.lamports;
      ataSupply += amount;
      if (amount > 0n) ixs.push(createBurnInstruction(ata, mint, player.publicKey, amount));
      ixs.push(createCloseAccountInstruction(ata, rentDest, player.publicKey));
      signers.push(player);
    }
    const mintInfo = await this.provider.connection.getAccountInfo(mint, 'confirmed');
    if (mintInfo && mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      const state = await getMint(this.provider.connection, mint, 'confirmed');
      if (state.supply === ataSupply) {
        returned += mintInfo.lamports;
        ixs.push(createCloseAccountInstruction(
          mint,
          rentDest,
          this.provider.wallet.publicKey,
        ));
      } else {
        console.warn(`[rent] mint still holds ${state.supply - ataSupply} chips`);
      }
    }
    if (ixs.length === 0) return 0;
    await this.sendSigned(ixs, signers);
    return returned;
  }

  /**
   * Close the room, the table, and the other casino accounts opened for this
   * session. Rent lands on `rentDest`. Testing builds only.
   */
  async closeSession(
    tableId: bigint,
    gameId: Uint8Array,
    players: web3.PublicKey[],
    rentDest: web3.PublicKey,
  ): Promise<void> {
    const admin = await loadWhitelistAdminProvider(this.provider.connection, undefined, 20_000_000);
    const adminKp = (admin.wallet as { payer?: web3.Keypair }).payer;
    if (!adminKp) throw new Error('whitelist admin key is required to close the session');
    const programId = this.pokerProgram.programId;
    const dealerPool = this.dealerPoolPDA(tableId);
    const gameIdBuf = Buffer.from(gameId);
    const candidates: web3.PublicKey[] = [
      this.gameStatePDA(gameId),
      this.protocolTreasuryPDA(),
      dealerPool,
      web3.PublicKey.findProgramAddressSync([Buffer.from('encrypted_betting'), gameIdBuf], programId)[0],
      web3.PublicKey.findProgramAddressSync([Buffer.from('bet_action_log'), gameIdBuf], programId)[0],
      web3.PublicKey.findProgramAddressSync([Buffer.from('game_table_key'), gameIdBuf], programId)[0],
    ];
    for (let index = 0; index < players.length; index++) {
      const player = players[index]!;
      candidates.push(
        this.roomWalletPDA(player),
        this.tableEscrowPDA(player, tableId),
        this.whitelistPDA(player),
        this.pendingDepositPDA(player),
        this.poolStakePDA(dealerPool, player),
        web3.PublicKey.findProgramAddressSync(
          [Buffer.from('player'), gameIdBuf, Buffer.from([index])],
          programId,
        )[0],
        web3.PublicKey.findProgramAddressSync(
          [Buffer.from('player_game_escrow'), gameIdBuf, Buffer.from([index])],
          programId,
        )[0],
        web3.PublicKey.findProgramAddressSync(
          [Buffer.from('showdown_material'), gameIdBuf, Buffer.alloc(8), Buffer.from([index])],
          programId,
        )[0],
      );
    }
    const room = this.roomPDA();
    const table = this.tablePDA(tableId);
    const mint = await this.roomMint();
    const tokenVault = this.vaultPDA();
    const infos = await this.provider.connection.getMultipleAccountsInfo(candidates, 'confirmed');
    const remaining = candidates.filter((pubkey, index) => {
      const info = infos[index];
      return !!info
        && info.owner.equals(programId)
        && !pubkey.equals(room)
        && !pubkey.equals(table)
        && !pubkey.equals(rentDest);
    });
    for (let start = 0; start < remaining.length; start += 50) {
      const batch = remaining.slice(start, start + 50);
      const ix = new web3.TransactionInstruction({
        programId,
        keys: [
          { pubkey: adminKp.publicKey, isSigner: true, isWritable: false },
          { pubkey: rentDest, isSigner: false, isWritable: true },
          { pubkey: room, isSigner: false, isWritable: false },
          ...batch.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
        ],
        data: CLOSE_SESSION_ACCOUNTS,
      });
      await this.sendSigned([ix], [adminKp]);
    }
    const ix = new web3.TransactionInstruction({
      programId,
      keys: [
        { pubkey: adminKp.publicKey, isSigner: true, isWritable: false },
        { pubkey: rentDest, isSigner: false, isWritable: true },
        { pubkey: room, isSigner: false, isWritable: true },
        { pubkey: table, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: tokenVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: CLOSE_SESSION,
    });
    await this.sendSigned([ix], [adminKp]);
  }

  private async sendSigned(
    ixs: web3.TransactionInstruction[],
    extra: web3.Keypair[],
  ): Promise<void> {
    const latest = await this.provider.connection.getLatestBlockhash('confirmed');
    const tx = new web3.Transaction({
      feePayer: this.provider.wallet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(...ixs);
    if (extra.length > 0) tx.partialSign(...extra);
    const signed = await this.provider.wallet.signTransaction(tx);
    const signature = await this.provider.connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: 'confirmed',
    });
    const confirmation = await this.provider.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(`reclaim transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
  }

  async leaveTable(tableId: bigint, player = this.provider.wallet.publicKey): Promise<void> {
    const owner = await this.sessionOwner(player);
    await (this.pokerProgram.methods as any)
      .leaveTable()
      .accounts({
        player,
        whitelistEntry: this.whitelistPDA(player),
        tableState: this.tablePDA(tableId),
        roomWallet: this.roomWalletPDA(player),
        tableEscrow: this.tableEscrowPDA(player, tableId),
        roomSession: this.roomSessionPDA(player),
        roomSessionLock: this.roomSessionLockPDA(owner),
      })
      .remainingAccounts(casinoVaultRemaining(player, this.pokerProgram.programId))
      .rpc();
  }

  async sitOut(tableId: bigint, player: web3.PublicKey | web3.Keypair = this.provider.wallet.publicKey): Promise<void> {
    const playerKp = 'secretKey' in (player as object) ? (player as web3.Keypair) : null;
    const playerPk = playerKp ? playerKp.publicKey : (player as web3.PublicKey);
    const owner = await this.sessionOwner(playerPk);
    const ix = sitOutInstruction({
      casinoProgramId: this.pokerProgram.programId,
      player: playerPk,
      whitelistEntry: this.whitelistPDA(playerPk),
      tableState: this.tablePDA(tableId),
      roomWallet: this.roomWalletPDA(playerPk),
      tableEscrow: this.tableEscrowPDA(playerPk, tableId),
      roomSession: this.roomSessionPDA(playerPk),
      roomSessionLock: this.roomSessionLockPDA(owner),
    });
    const latest = await this.provider.connection.getLatestBlockhash('confirmed');
    const tx = new web3.Transaction({
      feePayer: this.provider.wallet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(ix);
    if (playerKp && !playerKp.publicKey.equals(this.provider.wallet.publicKey)) {
      tx.partialSign(playerKp);
    }
    const signed = await this.provider.wallet.signTransaction(tx);
    const signature = await this.provider.connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: 'confirmed',
    });
    const confirmation = await this.provider.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(`sit_out failed: ${JSON.stringify(confirmation.value.err)}`);
    }
  }

  async fetchTable(tableId: bigint) {
    return (this.pokerProgram.account as any).tableState.fetch(this.tablePDA(tableId));
  }

  async fetchRoomWallet(player = this.provider.wallet.publicKey) {
    return (this.pokerProgram.account as any).roomWallet.fetch(this.roomWalletPDA(player));
  }

  async fetchProtocolTreasury() {
    return (this.pokerProgram.account as any).protocolTreasury.fetch(this.protocolTreasuryPDA());
  }

  async fetchDealerPool(tableId: bigint) {
    return (this.pokerProgram.account as any).dealerPool.fetch(this.dealerPoolPDA(tableId));
  }

  async waitForRoomWalletCredited(player = this.provider.wallet.publicKey): Promise<void> {
    const walletPda = this.roomWalletPDA(player);
    await this.polling.waitForCallback(
      walletPda,
      async (pda) => (this.pokerProgram.account as any).roomWallet.fetch(pda),
      // Anchor returns BN — never compare BN !== 0n (always true).
      (state) => BigInt((state.nonce ?? 0).toString()) !== 0n
        && BigInt((state.balanceU64 ?? state.balance_u64 ?? 0).toString()) > 0n,
      { timeout: 90000, interval: 2000 },
    );
    await this.arcium.reclaimFinalizedComputations();
  }

  async waitForTableBuyinLocked(
    tableId: bigint,
    player = this.provider.wallet.publicKey,
  ): Promise<void> {
    const escrowPda = this.tableEscrowPDA(player, tableId);
    await this.polling.waitForCallback(
      escrowPda,
      async (pda) => (this.pokerProgram.account as any).tableEscrow.fetch(pda),
      (state) => BigInt((state.nonce ?? 0).toString()) !== 0n,
      { timeout: 90000, interval: 2000 },
    );
    await this.arcium.reclaimFinalizedComputations();
  }

  async waitForDealerPoolStaked(tableId: bigint, nonceBefore: bigint): Promise<void> {
    const pda = this.dealerPoolPDA(tableId);
    await this.polling.waitForCallback(
      pda,
      async () => this.fetchDealerPool(tableId),
      (state) => BigInt((state.nonce ?? 0).toString()) !== nonceBefore,
      { timeout: 90_000, interval: 2_000 },
    );
    await this.arcium.reclaimFinalizedComputations();
  }

  async vaultBalance(vault: web3.PublicKey): Promise<bigint> {
    const acct = await getAccount(this.provider.connection, vault);
    return acct.amount;
  }

  async initWalletCompDefs(): Promise<void> {
    // CompDef init/upload requires MXE authority (not the ephemeral E2E payer).
    const adminProvider = await loadMxeAuthorityProvider(this.provider.connection);
    const adminArcium = new ArciumMPCHelper(loadCasinoProgram(adminProvider), adminProvider);
    for (const circuit of [
      'creditRoomBalance',
      'lockTableBuyin',
      'unlockTable',
      'debitForWithdraw',
      'settleCasinoHand',
      'stakeDealerPool',
      'redeemDealerPool',
      'applyCasinoPlayerNet',
      'fundPlayerGameEscrow',
      'returnPlayerGameEscrow',
    ] as const) {
      await adminArcium.initCompDef(circuit);
    }
  }
}
