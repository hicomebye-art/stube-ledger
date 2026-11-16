// 테스트 장부 모드
// 주소 끝에 ?test=이름 을 붙이면 실제 장부와 완전히 분리된 "테스트 장부"를 씁니다.
//  - 이 기기 저장 공간: 실제 장부와 다른 칸
//  - 구글 드라이브: "에스튜브 경리 앱 데이터 (테스트 이름)" 폴더 (실제 장부 폴더와 다름)
// 예) https://hicomebye-art.github.io/stube-ledger/?test=sync
// 화면에 보이는 앱 버전 (새 버전이 들어왔는지 확인용)
export const BUILD = '3.11 (11/16)';

const q = new URLSearchParams(location.search);
export const SANDBOX = (q.get('test') || '').replace(/[^0-9A-Za-z가-힣_-]/g, '').slice(0, 20);
// dev: 한 브라우저에서 기기 두 대를 흉내 낼 때만 씀 (자동 테스트용)
const DEV = SANDBOX ? (q.get('dev') || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 10) : '';
export const NS = SANDBOX ? `:test:${SANDBOX}${DEV ? ':' + DEV : ''}` : '';
