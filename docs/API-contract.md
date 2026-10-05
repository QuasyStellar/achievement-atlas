# API agreement — Achievement Atlas

Prefix /api; same-origin cookies. All JSON. Error {error:{code,message,requestId}}.

User: {id:string,email:string,displayName:string,role:'player'|'operator'}.
Achievement: {id:string,title:string,description:string,metric:'matches'|'wins'|'kills'|'xp',target:number,rarity:'common'|'rare'|'epic',icon:string,progress:number,unlocked:boolean,unlockedAt:string|null,unlockId:string|null,mint:MintJob|null}.
MintJob: {id:string,status:'pending'|'submitted'|'confirmed'|'failed',recipient:string,itemIndex:number|null,itemAddress:string|null,transactionHash:string|null,error:string|null,createdAt:string,updatedAt:string}.
Summary: {matches:number,wins:number,kills:number,xp:number,unlocked:number,total:number,minted:number}.

GET /health -> {status:'ok',service:'achievement-atlas',network:'testnet',demoMode:boolean,chain:{configured:boolean,collectionAddress:string|null,walletAddress:string|null,mintingEnabled:boolean}}.
GET /auth/me -> {user:User|null,csrfToken:string}; accessible logged-out, initializes anonymous cookie/token.
POST /auth/register {email,password,displayName} ->201 {user}; POST /auth/login {email,password} ->200 {user}; POST /auth/logout ->200 {ok:true}.
All mutating session routes require X-CSRF-Token from current /auth/me response. Refetch /auth/me after login/register because session token changes.
GET /achievements -> {achievements:Achievement[],summary:Summary} requires auth.
GET /events -> {events:[{id:string,eventId:string,type:string,occurredAt:string,payload:object,createdAt:string,unlocked:string[]}]}; unlocked lists achievement ids opened by that event, most recent first.
GET /rewards -> {rewards:[{unlockId:string,achievementId:string,title:string,unlockedAt:string,mint:MintJob|null}]}.
POST /rewards/:unlockId/mint {recipient:string} ->202 {mint:MintJob}; retries same destination return existing job. New recipient409. Auth owns unlock. Invalid TON address400. Chain not configured or explicitly disabled503 (do NOT simulate success).
GET /operator/users -> {users:User[]} operator only.
POST /operator/simulate {userId:string,scenario:'first-match'|'victory'|'ten-matches'|'hundred-kills'|'thousand-xp'} ->200 {processed:number,unlocked:string[]} operator+DEMO_MODE only; unique server-generated IDs. Button never sends ingestion API key.
POST /events/ingest uses X-Game-Key (not session/CSRF), {eventId:string,playerId:string,type:'match.completed'|'combat.completed'|'xp.earned',payload:object,occurredAt:ISOstring}. Match payload {won:boolean}; combat {kills:number}; xp {xp:number}. Source fixed by configured key. New201, identical retry200, same ID different body409. Bad key401.

Brand fictional Achievement Atlas. Russian UI; navigation Overview/Catalog/My rewards/Event history/Operator. State clearly TON testnet. No mock API responses or fabricated chain confirmations. Metadata address is destination, not proof of wallet ownership.
