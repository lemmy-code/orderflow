import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';

/** Single-node Kafka in KRaft mode (no ZooKeeper). */
export async function startKafka(): Promise<{ container: StartedKafkaContainer; brokers: string[] }> {
  const container = await new KafkaContainer('confluentinc/cp-kafka:7.7.1').withKraft().start();
  // The Testcontainers Kafka module advertises the host listener on container port 9093.
  return { container, brokers: [`${container.getHost()}:${container.getMappedPort(9093)}`] };
}
